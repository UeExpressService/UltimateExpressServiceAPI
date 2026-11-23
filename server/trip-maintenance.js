// Mapped distances are estimates. They are counted once when a booking first completes.
const DISTANCE_COLUMNS = {
    one_way_distance_km: 'DECIMAL(10,3) NULL', distance_source: 'VARCHAR(20) NULL',
    distance_pickup_location: 'VARCHAR(500) NULL', distance_delivery_location: 'VARCHAR(500) NULL'
};
const TABLES = [
    `CREATE TABLE IF NOT EXISTS completed_trip_mileage (
        service_request_id BIGINT UNSIGNED PRIMARY KEY, truck_id BIGINT UNSIGNED NOT NULL,
        one_way_km DECIMAL(10,3) NOT NULL, round_trip_km DECIMAL(12,1) NOT NULL,
        odometer_before DECIMAL(12,1) NOT NULL, odometer_after DECIMAL(12,1) NOT NULL,
        recorded_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX trip_mileage_truck(truck_id,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS truck_inspection_requests (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, truck_id BIGINT UNSIGNED NOT NULL,
        priority VARCHAR(12) NOT NULL DEFAULT 'normal', reason VARCHAR(2000) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending', requested_by BIGINT UNSIGNED NOT NULL,
        reviewed_by BIGINT UNSIGNED NULL, findings VARCHAR(2000) NOT NULL DEFAULT '',
        version INT UNSIGNED NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX inspection_truck_status(truck_id,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];
function roundTripKm(oneWay) { return Math.round((Number(oneWay) * 2 + Number.EPSILON) * 10) / 10; }

module.exports = function registerTripMaintenance(app, { dbp, withTransaction, requireRoles, auditUserAction, HttpError, sendError, ensureMaintenance }) {
    let setup;
    function ready() {
        if (!setup) setup = (async () => {
            await ensureMaintenance();
            const [columns] = await dbp.query('SHOW COLUMNS FROM service_requests');
            const existing = new Set(columns.map(row => row.Field));
            for (const [name,definition] of Object.entries(DISTANCE_COLUMNS)) if (!existing.has(name)) {
                try { await dbp.query(`ALTER TABLE service_requests ADD COLUMN ${name} ${definition}`); }
                catch(error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
            }
            for (const sql of TABLES) await dbp.query(sql);
        })().catch(error => { setup = undefined; throw error; });
        return setup;
    }
    function prepareDistance(previous, body, role, pickup, delivery) {
        let distance = previous?.one_way_distance_km ?? null;
        if (body.one_way_distance_km !== undefined) {
            if (role !== 'dispatcher') throw new HttpError(403,'Only Dispatch can save the mapped trip distance.');
            distance = body.one_way_distance_km;
            if (distance !== null && (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0 || distance > 5000)) {
                throw new HttpError(400,'The one-way road-map distance must be greater than zero and no more than 5,000 km.');
            }
            if (distance !== null) distance = Math.round(distance * 1000) / 1000;
            if (distance === 0) throw new HttpError(400,'The road-map distance is too small to record.');
        } else if (previous?.distance_pickup_location !== pickup || previous?.distance_delivery_location !== delivery) {
            distance = null;
        }
        return { one_way_distance_km:distance, distance_source:distance == null ? null : 'road_map',
            distance_pickup_location:distance == null ? null : pickup, distance_delivery_location:distance == null ? null : delivery };
    }
    async function applyCompletion(connection, booking, actorId) {
        if (!booking.assigned_truck_id) throw new HttpError(409,'Assign the delivery truck before completing this booking.');
        if (!(Number(booking.one_way_distance_km) > 0) || booking.distance_source !== 'road_map' ||
            booking.distance_pickup_location !== booking.pickup_location || booking.distance_delivery_location !== booking.delivery_location) {
            throw new HttpError(409,'Load the road route in the booking and save its map distance before completing the delivery.');
        }
        const [[truck]] = await connection.query('SELECT id FROM trucks WHERE id=? FOR UPDATE',[booking.assigned_truck_id]);
        if (!truck) throw new HttpError(409,'The assigned truck no longer exists.');
        const [[record]] = await connection.query('SELECT * FROM truck_maintenance WHERE truck_id=? FOR UPDATE',[truck.id]);
        if (record?.odometer == null) throw new HttpError(409,'Ask the Supervisor to record this truck’s starting odometer in Truck Maintenance before completing the delivery.');
        const before = Number(record.odometer), distance = roundTripKm(booking.one_way_distance_km);
        const after = Math.round((before + distance) * 10) / 10;
        if (after > 100000000) throw new HttpError(409,'The resulting odometer is outside the allowed range. Ask the Supervisor to check the readings.');
        await connection.query(`INSERT INTO completed_trip_mileage
            (service_request_id,truck_id,one_way_km,round_trip_km,odometer_before,odometer_after,recorded_by)
            VALUES (?,?,?,?,?,?,?)`,[booking.id,truck.id,booking.one_way_distance_km,distance,before,after,actorId]);
        const version = Number(record.version) + 1;
        await connection.query('UPDATE truck_maintenance SET odometer=?,version=?,updated_by=? WHERE truck_id=?',[after,version,actorId,truck.id]);
        await connection.query('INSERT INTO truck_maintenance_events (truck_id,snapshot,recorded_by) VALUES (?,?,?)',[
            truck.id,JSON.stringify({...record,odometer:after,version,event_type:'completed_delivery_distance',
                service_request_id:booking.id,one_way_km:Number(booking.one_way_distance_km),round_trip_km:distance,odometer_before:before}),actorId
        ]);
        return { truck_id:truck.id, one_way_km:Number(booking.one_way_distance_km), round_trip_km:distance, odometer:after };
    }
    const handle = action => async (req,res) => {
        res.setHeader('Cache-Control','no-store');
        try { await ready(); await action(req,res); } catch(error) { sendError(res,error,'Unable to process the truck inspection request.'); }
    };
    app.get('/api/maintenance-requests',requireRoles('dispatcher','supervisor','manager'),
        auditUserAction('inspection_requests.viewed','truck_inspection','Viewed maintenance inspection requests.',true),handle(async (req,res) => {
            const [rows] = await dbp.query(`SELECT r.*,t.license_plate,t.type AS truck_type,u.name AS requested_by_name,v.name AS reviewed_by_name
                FROM truck_inspection_requests r LEFT JOIN trucks t ON t.id=r.truck_id
                LEFT JOIN users u ON u.id=r.requested_by LEFT JOIN users v ON v.id=r.reviewed_by
                ORDER BY (r.status='checked'),r.created_at DESC,r.id DESC LIMIT 200`);
            res.json(rows);
        }));
    app.post('/api/maintenance-requests',requireRoles('dispatcher'),
        auditUserAction('inspection_request.created','truck_inspection','Requested a Supervisor truck inspection.'),handle(async (req,res) => {
            const { truck_id,priority,reason } = req.body || {};
            if (!Number.isSafeInteger(truck_id) || truck_id <= 0 || !['normal','urgent'].includes(priority) ||
                typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new HttpError(400,'Select a truck, priority and a reason of up to 2,000 characters.');
            const id = await withTransaction(async connection => {
                const [[truck]] = await connection.query('SELECT id FROM trucks WHERE id=? FOR UPDATE',[truck_id]);
                if (!truck) throw new HttpError(404,'Truck not found.');
                const [open] = await connection.query("SELECT id FROM truck_inspection_requests WHERE truck_id=? AND status IN ('pending','in_progress')",[truck_id]);
                if (open.length) throw new HttpError(409,`This truck already has an open inspection request (MC-${open[0].id}). Review that request first.`);
                const [saved] = await connection.query('INSERT INTO truck_inspection_requests (truck_id,priority,reason,requested_by) VALUES (?,?,?,?)',[truck_id,priority,reason.trim(),req.auth.sub]);
                return saved.insertId;
            });
            res.locals.auditEntityId=id;
            res.status(201).json({id,message:'Maintenance check requested. The Supervisor can now review it.'});
        }));
    app.put('/api/maintenance-requests/:id',requireRoles('supervisor'),
        auditUserAction('inspection_request.reviewed','truck_inspection','Recorded a Supervisor truck inspection review.'),handle(async (req,res) => {
            const id=Number(req.params.id),{ status,findings,version }=req.body || {};
            if (!Number.isSafeInteger(id) || id<=0 || !['in_progress','checked'].includes(status) || typeof findings!=='string' || findings.length>2000 ||
                status==='checked' && !findings.trim() || !Number.isSafeInteger(version) || version<0) throw new HttpError(400,'Choose a review status and enter findings before marking the truck checked.');
            await withTransaction(async connection => {
                const [[previous]]=await connection.query('SELECT * FROM truck_inspection_requests WHERE id=? FOR UPDATE',[id]);
                if (!previous) throw new HttpError(404,'Maintenance check request not found.');
                if (previous.status==='checked') throw new HttpError(409,'This inspection was already completed.');
                if (Number(previous.version)!==version) throw new HttpError(409,'Another Supervisor updated this request. Refresh before saving.');
                await connection.query('UPDATE truck_inspection_requests SET status=?,findings=?,reviewed_by=?,version=version+1 WHERE id=?',[status,findings.trim(),req.auth.sub,id]);
            });
            res.locals.auditEntityId=id;
            res.json({message:'Inspection review saved. Record actual readings in Truck Maintenance and update fleet availability separately when needed.'});
        }));
    return { ready,prepareDistance,applyCompletion };
};
module.exports.roundTripKm=roundTripKm;
module.exports.DISTANCE_COLUMNS=DISTANCE_COLUMNS;
module.exports.TABLES=TABLES;

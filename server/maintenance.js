// Provisional reminders, editable per truck. These are not manufacturer clearance rules.
const POSITIONS = ['front_right','front_left','rear_right_outer','rear_right_inner','rear_left_outer','rear_left_inner',
    'second_rear_right_outer','second_rear_right_inner','second_rear_left_outer','second_rear_left_inner','spare'];
function dateOnly(value) { return value instanceof Date ? value.toISOString().slice(0,10) : String(value || '').slice(0,10); }
function validDate(value, latest = '9999-12-31') {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1000-01-01' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value && value <= latest;
}
const COMPONENT_COLUMNS = {
    vehicle_model: "VARCHAR(100) NOT NULL DEFAULT ''",
    battery_serial: "VARCHAR(255) NOT NULL DEFAULT ''", battery_installed_at: 'DATE NULL', battery_due_date: 'DATE NULL', battery_notes: "VARCHAR(1000) NOT NULL DEFAULT ''",
    fuel_filter_model: "VARCHAR(255) NOT NULL DEFAULT ''", fuel_filter_installed_at: 'DATE NULL', fuel_filter_due_date: 'DATE NULL', fuel_filter_notes: "VARCHAR(1000) NOT NULL DEFAULT ''"
};
function componentState(installed, due, details, today) {
    if (!due) return installed || details ? 'due_date_required' : 'not_recorded';
    if (due < today) return 'overdue';
    if (due === today) return 'due';
    return (Date.parse(due)-Date.parse(today))/86400000 <= 14 ? 'due_soon' : 'scheduled';
}
function addMonths(day, months) {
    const [year,month,date] = day.split('-').map(Number), first = new Date(Date.UTC(year,month-1+months,1));
    const last = new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
    first.setUTCDate(Math.min(date,last)); return first.toISOString().slice(0,10);
}
function recommendations(row, today) {
    const data = { ...row, oil_interval_km:Number(row.oil_interval_km || 5000), oil_interval_months:Number(row.oil_interval_months || 3) };
    let tires = row.tire_readings;
    if (typeof tires === 'string') { try { tires = JSON.parse(tires); } catch { tires = {}; } }
    data.tire_readings = tires || {};
    data.last_oil_date = dateOnly(row.last_oil_date) || null;
    data.tire_checked_at = dateOnly(row.tire_checked_at) || null;
    for (const prefix of ['battery','fuel_filter']) {
        data[prefix+'_installed_at'] = dateOnly(row[prefix+'_installed_at']) || null;
        data[prefix+'_due_date'] = dateOnly(row[prefix+'_due_date']) || null;
        data[prefix+'_state'] = componentState(data[prefix+'_installed_at'],data[prefix+'_due_date'],row[prefix === 'battery' ? 'battery_serial' : 'fuel_filter_model'] || row[prefix+'_notes'],today);
    }
    const baseline = row.odometer != null && row.last_oil_km != null && data.last_oil_date;
    data.next_oil_km = row.last_oil_km == null ? null : Number(row.last_oil_km) + data.oil_interval_km;
    data.next_oil_date = data.last_oil_date ? addMonths(data.last_oil_date,data.oil_interval_months) : null;
    data.remaining_km = baseline ? data.next_oil_km - Number(row.odometer) : null;
    data.oil_state = !baseline ? 'baseline_required' : data.remaining_km <= 0 || data.next_oil_date <= today ? 'due' :
        data.remaining_km <= 500 || (Date.parse(data.next_oil_date)-Date.parse(today))/86400000 <= 14 ? 'due_soon' : 'scheduled';
    data.tire_alerts = Object.entries(data.tire_readings).filter(([,value]) => value != null).map(([position,value]) => {
        const thirtyseconds = row.tire_unit === 'mm' ? Number(value)*32/25.4 : Number(value);
        return { position, value:Number(value), state:thirtyseconds <= 2 ? 'danger' : thirtyseconds <= 4 ? 'replacement' : thirtyseconds < 5 ? 'monitor' : thirtyseconds >= 10 ? 'excellent' : 'good' };
    });
    data.tire_state = !data.tire_alerts.length ? 'not_recorded' : data.tire_alerts.some(row => row.state === 'danger') ? 'danger' : data.tire_alerts.some(row => row.state === 'replacement') ? 'replacement' : 'monitor';
    return data;
}
const TABLES = [
    `CREATE TABLE IF NOT EXISTS truck_maintenance (
        truck_id BIGINT UNSIGNED PRIMARY KEY, odometer DECIMAL(12,1) NULL,
        oil_interval_km INT UNSIGNED NOT NULL DEFAULT 5000, oil_interval_months INT UNSIGNED NOT NULL DEFAULT 3,
        last_oil_km DECIMAL(12,1) NULL,last_oil_date DATE NULL,engine_number VARCHAR(100) NOT NULL DEFAULT '',
        oil_filter VARCHAR(200) NOT NULL DEFAULT '',oil_liters DECIMAL(8,2) NULL,
        tire_size VARCHAR(100) NOT NULL DEFAULT '',tire_unit VARCHAR(20) NULL,tire_readings JSON NULL,tire_checked_at DATE NULL,
        notes VARCHAR(2000) NOT NULL DEFAULT '',version INT UNSIGNED NOT NULL DEFAULT 0,updated_by BIGINT UNSIGNED NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS truck_maintenance_events (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,truck_id BIGINT UNSIGNED NOT NULL,
        snapshot JSON NOT NULL,recorded_by BIGINT UNSIGNED NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX maintenance_history(truck_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];
function registerMaintenance(app, { dbp, withTransaction, requireRoles, auditUserAction, HttpError, sendError }) {
    let ready;
    function ensure() {
        if (!ready) ready = (async () => {
            for(const sql of TABLES) await dbp.query(sql);
            const [columns] = await dbp.query('SHOW COLUMNS FROM truck_maintenance');
            const existing = new Set(columns.map(column => column.Field));
            for(const [name,definition] of Object.entries(COMPONENT_COLUMNS)) if (!existing.has(name)) {
                try { await dbp.query(`ALTER TABLE truck_maintenance ADD COLUMN ${name} ${definition}`); }
                catch(error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
            }
        })().catch(error => { ready = undefined; throw error; });
        return ready;
    }
    const handle = work => async (req,res) => {
        res.setHeader('Cache-Control','no-store');
        try { await ensure(); await work(req,res); } catch(error) { sendError(res,error,'Unable to process truck maintenance.'); }
    };
    const today = () => new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'});
    const roles = () => requireRoles('supervisor','manager');
    app.get('/api/truck-maintenance', roles(), auditUserAction('maintenance.viewed','truck','Viewed truck maintenance reminders.',true), handle(async (req,res) => {
        const [rows] = await dbp.query(`SELECT t.id,t.license_plate,t.type,t.status,m.odometer,m.oil_interval_km,m.oil_interval_months,
            m.last_oil_km,m.last_oil_date,m.engine_number,m.oil_filter,m.oil_liters,m.tire_size,m.tire_unit,m.tire_readings,m.tire_checked_at,m.notes,m.version,m.updated_at,
            ${Object.keys(COMPONENT_COLUMNS).map(name => 'm.'+name).join(',')}
            FROM trucks t LEFT JOIN truck_maintenance m ON m.truck_id=t.id ORDER BY t.license_plate`);
        res.json({ today:today(), rows:rows.map(row => recommendations(row,today())) });
    }));
    app.get('/api/trucks/:id/maintenance-history', roles(), auditUserAction('maintenance.history_viewed','truck','Viewed recorded maintenance history.',true), handle(async (req,res) => {
        const id = Number(req.params.id); if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400,'Invalid truck ID.');
        const [rows] = await dbp.query('SELECT id,snapshot,created_at FROM truck_maintenance_events WHERE truck_id=? ORDER BY id DESC LIMIT 100',[id]);
        res.json(rows);
    }));
    app.put('/api/trucks/:id/maintenance', roles(), auditUserAction('maintenance.recorded','truck','Recorded truck maintenance readings and reminder settings.'), handle(async (req,res) => {
        const id = Number(req.params.id), body = req.body || {}, day = today();
        const numeric = (value,max,nullable=false) => nullable && value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
        const oilDate = body.last_oil_date, tireDate = body.tire_checked_at;
        if (!Number.isSafeInteger(id) || id <= 0 || !numeric(body.odometer,100000000,true) || !numeric(body.last_oil_km,100000000,true) ||
            (body.last_oil_km != null && (body.odometer == null || body.last_oil_km > body.odometer)) || !Number.isInteger(body.oil_interval_km) || body.oil_interval_km < 1 || body.oil_interval_km > 100000 ||
            !Number.isInteger(body.oil_interval_months) || body.oil_interval_months < 1 || body.oil_interval_months > 36 ||
            (oilDate !== null && !validDate(oilDate,day)) || (body.last_oil_km == null) !== (oilDate === null) ||
            (tireDate !== null && !validDate(tireDate,day)) || !numeric(body.oil_liters,1000,true) ||
            !['mm','32nds_inch'].includes(body.tire_unit) || !body.tire_readings || typeof body.tire_readings !== 'object' || Array.isArray(body.tire_readings) ||
            Object.entries(body.tire_readings).some(([key,value]) => !POSITIONS.includes(key) || !numeric(value,100,true)) ||
            !['engine_number','oil_filter','tire_size','notes'].every(key => typeof body[key] === 'string' && body[key].length <= ({engine_number:100,oil_filter:200,tire_size:100,notes:2000}[key])) ||
            !(body.version === null || Number.isSafeInteger(body.version) && body.version >= 0)) throw new HttpError(400,'Check the odometer, service dates, service intervals and tire readings. Dates cannot be in the future; last oil mileage cannot exceed the current odometer.');
        if (Object.values(body.tire_readings).some(value => value != null) && !tireDate) throw new HttpError(400,'Enter the date of the tire inspection.');
        await withTransaction(async connection => {
            const [[truck]] = await connection.query('SELECT id FROM trucks WHERE id=? FOR UPDATE',[id]);
            if (!truck) throw new HttpError(404,'Truck not found.');
            const [[previous]] = await connection.query('SELECT * FROM truck_maintenance WHERE truck_id=? FOR UPDATE',[id]);
            if ((previous ? Number(previous.version) : null) !== body.version) throw new HttpError(409,'Maintenance was updated by another user. Refresh and review the latest readings.');
            if (previous?.odometer != null && (body.odometer == null || body.odometer < Number(previous.odometer))) throw new HttpError(409,'The odometer cannot be cleared or decreased. Verify the reading before saving.');
            // Older clients omit these fields. Preserve the saved component records in that case.
            const components = {};
            for (const [key,definition] of Object.entries(COMPONENT_COLUMNS)) {
                const isDate = definition === 'DATE NULL';
                let value = Object.hasOwn(body,key) ? body[key] : previous?.[key] ?? (isDate ? null : '');
                if (isDate) {
                    if (!Object.hasOwn(body,key)) value = dateOnly(value) || null;
                    if (value !== null && !validDate(value,key.endsWith('_installed_at') ? day : undefined)) throw new HttpError(400,'Enter valid battery and fuel-filter dates. Installation dates cannot be in the future.');
                } else {
                    const limit = key === 'vehicle_model' ? 100 : key.endsWith('_notes') ? 1000 : 255;
                    if (typeof value !== 'string' || value.length > limit) throw new HttpError(400,`Check component text fields: model/serial up to 255 characters, vehicle model up to 100 and notes up to 1,000.`);
                    value = value.trim();
                }
                components[key] = value;
            }
            for (const prefix of ['battery','fuel_filter']) {
                const installed = components[prefix+'_installed_at'], due = components[prefix+'_due_date'];
                if (installed && due && due < installed) throw new HttpError(400,'A component due date cannot be earlier than its installation date.');
            }
            const version = previous ? Number(previous.version)+1 : 0;
            const values = [id,body.odometer,body.oil_interval_km,body.oil_interval_months,body.last_oil_km,oilDate,body.engine_number.trim(),body.oil_filter.trim(),body.oil_liters,body.tire_size.trim(),body.tire_unit,JSON.stringify(body.tire_readings),tireDate,body.notes.trim(),version,req.auth.sub];
            const names = Object.keys(COMPONENT_COLUMNS);
            await connection.query(`INSERT INTO truck_maintenance (truck_id,odometer,oil_interval_km,oil_interval_months,last_oil_km,last_oil_date,engine_number,oil_filter,oil_liters,tire_size,tire_unit,tire_readings,tire_checked_at,notes,version,updated_by,${names.join(',')})
                VALUES (${Array(16+names.length).fill('?').join(',')}) ON DUPLICATE KEY UPDATE odometer=VALUES(odometer),oil_interval_km=VALUES(oil_interval_km),oil_interval_months=VALUES(oil_interval_months),last_oil_km=VALUES(last_oil_km),last_oil_date=VALUES(last_oil_date),engine_number=VALUES(engine_number),oil_filter=VALUES(oil_filter),oil_liters=VALUES(oil_liters),tire_size=VALUES(tire_size),tire_unit=VALUES(tire_unit),tire_readings=VALUES(tire_readings),tire_checked_at=VALUES(tire_checked_at),notes=VALUES(notes),version=VALUES(version),updated_by=VALUES(updated_by),${names.map(name => name+'=VALUES('+name+')').join(',')}`,[...values,...Object.values(components)]);
            await connection.query('INSERT INTO truck_maintenance_events (truck_id,snapshot,recorded_by) VALUES (?,?,?)',[id,JSON.stringify({...body,...components,version}),req.auth.sub]);
        });
        res.json({ message:'Maintenance readings saved. Truck dispatch availability was not changed.' });
    }));
    return { ready:ensure };
}
module.exports = registerMaintenance;
module.exports.recommendations = recommendations;
module.exports.addMonths = addMonths;
module.exports.POSITIONS = POSITIONS;
module.exports.componentState = componentState;

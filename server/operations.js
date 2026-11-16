const { createHash } = require('node:crypto');

// These are the starting amounts already published on the landing page.
const CATALOG = [
    { key: 'light', name: 'Light Duty Van', amount: 5000, image: 'lightduty.jpg' },
    { key: 'medium', name: 'Medium Box Truck', amount: 12000, image: 'medium.jpg' },
    { key: 'heavy', name: 'Heavy Cargo Truck', amount: 20000, image: '10wheller.webp' },
    { key: 'reefer', name: 'Refrigerated Truck', amount: 18000, image: 'refeer.webp' },
    { key: 'wing', name: 'Wing Van / Trailer', amount: 30000, image: 'wingvan.webp' }
];
function category(type) {
    if (/refrig|reefer/i.test(type)) return 'reefer';
    if (/wing|trailer/i.test(type)) return 'wing';
    if (/L300|light|4.wheel/i.test(type)) return 'light';
    if (/flatbed|open|10.wheel|heavy/i.test(type)) return 'heavy';
    if (/box|closed|6.wheel|medium/i.test(type)) return 'medium';
    return null;
}
function version(row) {
    const keys = ['cargo_type', 'cargo_weight', 'special_requirements', 'pickup_location', 'delivery_location',
        'pickup_date', 'preferred_time', 'truck_type', 'assigned_driver_id', 'assigned_truck_id', 'quoted_amount',
        'contact_person', 'contact_phone', 'contact_email'];
    return createHash('sha256').update(JSON.stringify(keys.map(key => row[key] ?? null))).digest('hex');
}
const TABLES = [
    `CREATE TABLE IF NOT EXISTS driver_shifts (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, driver_id BIGINT UNSIGNED NOT NULL,
        work_date DATE NOT NULL, time_in TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, time_out TIMESTAMP NULL,
        recorded_in_by BIGINT UNSIGNED NOT NULL, recorded_out_by BIGINT UNSIGNED NULL,
        UNIQUE KEY driver_day (driver_id, work_date), INDEX open_shifts (driver_id, time_out)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS supervisor_booking_reviews (
        service_request_id BIGINT UNSIGNED PRIMARY KEY, sent_by BIGINT UNSIGNED NOT NULL,
        sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_version CHAR(64) NOT NULL,
        reviewed_by BIGINT UNSIGNED NULL, reviewed_at TIMESTAMP NULL, reviewed_version CHAR(64) NULL,
        notes VARCHAR(2000) NOT NULL DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

module.exports = function registerOperations(app, { dbp, withTransaction, requireRoles, HttpError, sendError, auditUserAction }) {
    let ready;
    function ensure() {
        if (!ready) ready = (async () => { for (const sql of TABLES) await dbp.query(sql); })()
            .catch(error => { ready = null; throw error; });
        return ready;
    }
    const audit = (action, type, summary, read = false) => auditUserAction(action, type, summary, read);
    const handle = work => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { await work(req, res); } catch (error) { sendError(res, error, 'Unable to process fleet operations.'); }
    };
    function id(value) {
        if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, 'A valid record ID is required.');
        return Number(value);
    }
    async function today(connection = dbp) {
        const [[row]] = await connection.query("SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+08:00'),'%Y-%m-%d') AS today");
        return row.today;
    }
    async function booking(connection, bookingId, lock = false) {
        const [[row]] = await connection.query(`SELECT * FROM service_requests WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [bookingId]);
        if (!row) throw new HttpError(404, 'Booking not found.');
        return row;
    }
    app.get('/api/customer/fleet', audit('fleet.availability_viewed', 'truck', 'Viewed current fleet availability and published starting amounts.', true),
        requireRoles('customer', 'manager', 'supervisor', 'dispatcher'), handle(async (req, res) => {
            const [trucks] = await dbp.query("SELECT type,status,capacity FROM trucks WHERE license_plate NOT LIKE 'DEMO-%' AND license_plate NOT LIKE 'TEST-%'");
            res.json({ checked_at: new Date().toISOString(), categories: CATALOG.map(item => {
                const units = trucks.filter(truck => category(truck.type) === item.key);
                return { ...item, available: units.filter(truck => truck.status === 'available').length,
                    total: units.length, types: [...new Set(units.map(truck => truck.type))] };
            }) });
        }));

    app.get('/api/driver-shifts', audit('attendance.viewed', 'driver_shift', 'Viewed daily driver attendance.', true),
        requireRoles('supervisor', 'manager'), handle(async (req, res) => {
            await ensure();
            const day = req.query.date || await today();
            if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day || day > await today()) {
                throw new HttpError(400, 'Choose a valid date up to today.');
            }
            const [rows] = await dbp.query(`SELECT d.id AS driver_id,d.name,s.id,s.work_date,s.time_in,s.time_out,
                o.id AS open_id,o.work_date AS open_work_date,o.time_in AS open_time_in
                FROM drivers d LEFT JOIN driver_shifts s ON s.driver_id=d.id AND s.work_date=?
                LEFT JOIN driver_shifts o ON o.driver_id=d.id AND o.time_out IS NULL ORDER BY d.name`, [day]);
            res.json({ date: day, today: await today(), rows });
        }));
    app.post('/api/drivers/:id/time-in', audit('attendance.time_in', 'driver_shift', 'Recorded a driver daily time in.'),
        requireRoles('supervisor', 'manager'), handle(async (req, res) => {
            await ensure();
            const driverId = id(req.params.id);
            const result = await withTransaction(async connection => {
                const [[driver]] = await connection.query('SELECT id FROM drivers WHERE id=? FOR UPDATE', [driverId]);
                if (!driver) throw new HttpError(404, 'Driver not found.');
                const [open] = await connection.query('SELECT id FROM driver_shifts WHERE driver_id=? AND time_out IS NULL', [driverId]);
                if (open.length) throw new HttpError(409, 'This driver already has an open shift. Record time out first.');
                const day = await today(connection);
                const [existing] = await connection.query('SELECT id FROM driver_shifts WHERE driver_id=? AND work_date=?', [driverId, day]);
                if (existing.length) throw new HttpError(409, 'A daily shift has already been recorded for this driver today.');
                const [inserted] = await connection.query('INSERT INTO driver_shifts (driver_id,work_date,recorded_in_by) VALUES (?,?,?)', [driverId, day, req.auth.sub]);
                return inserted.insertId;
            });
            res.locals.auditEntityId = result;
            res.status(201).json({ id: result, message: 'Time in recorded.' });
        }));
    app.post('/api/drivers/:id/time-out', audit('attendance.time_out', 'driver_shift', 'Recorded a driver daily time out.'),
        requireRoles('supervisor', 'manager'), handle(async (req, res) => {
            await ensure();
            const result = await withTransaction(async connection => {
                const driverId = id(req.params.id);
                const [[driver]] = await connection.query('SELECT id FROM drivers WHERE id=? FOR UPDATE', [driverId]);
                if (!driver) throw new HttpError(404, 'Driver not found.');
                const [[shift]] = await connection.query('SELECT id FROM driver_shifts WHERE driver_id=? AND time_out IS NULL FOR UPDATE', [driverId]);
                if (!shift) throw new HttpError(409, 'This driver has no open shift.');
                await connection.query('UPDATE driver_shifts SET time_out=CURRENT_TIMESTAMP,recorded_out_by=? WHERE id=?', [req.auth.sub, shift.id]);
                return shift.id;
            });
            res.locals.auditEntityId = result;
            res.json({ id: result, message: 'Time out recorded.' });
        }));

    function reviewState(row, saved) {
        const current = version(row);
        return { ...saved, version: current, state: !saved ? 'not_sent' : saved.sent_version !== current ? 'changed' :
            saved.reviewed_version === current ? 'reviewed' : 'awaiting_review' };
    }
    const handoff = '/api/service-requests/:id/supervisor-review';
    app.get(handoff, audit('booking_review.status_viewed', 'service_request', 'Viewed supervisor handoff status.', true),
        requireRoles('dispatcher', 'supervisor', 'manager'), handle(async (req, res) => {
            await ensure();
            const bookingId = id(req.params.id), row = await booking(dbp, bookingId);
            const [[saved]] = await dbp.query('SELECT * FROM supervisor_booking_reviews WHERE service_request_id=?', [bookingId]);
            res.json({ ...reviewState(row, saved), can_send: ['approved','ongoing'].includes(row.status) && Boolean(row.assigned_driver_id && row.assigned_truck_id) });
        }));
    app.post(handoff, audit('booking_review.sent', 'service_request', 'Sent a confirmed booking for supervisor review; dispatch remains available.'),
        requireRoles('dispatcher'), handle(async (req, res) => {
            await ensure();
            const bookingId = id(req.params.id);
            const result = await withTransaction(async connection => {
                const row = await booking(connection, bookingId, true);
                if (!['approved', 'ongoing'].includes(row.status) || !row.assigned_driver_id || !row.assigned_truck_id) {
                    throw new HttpError(409, 'Save a confirmed booking with an assigned driver and truck first.');
                }
                const current = version(row);
                const [[saved]] = await connection.query('SELECT * FROM supervisor_booking_reviews WHERE service_request_id=?', [bookingId]);
                if (saved?.sent_version === current) return reviewState(row, saved);
                await connection.query(`INSERT INTO supervisor_booking_reviews (service_request_id,sent_by,sent_version) VALUES (?,?,?)
                    ON DUPLICATE KEY UPDATE sent_by=VALUES(sent_by),sent_at=CURRENT_TIMESTAMP,sent_version=VALUES(sent_version),
                    reviewed_by=NULL,reviewed_at=NULL,reviewed_version=NULL,notes=''`, [bookingId, req.auth.sub, current]);
                return { state: 'awaiting_review' };
            });
            res.locals.auditEntityId = bookingId;
            res.json(result);
        }));
    app.get('/api/supervisor/confirmed-bookings', audit('booking_review.queue_viewed', 'service_request', 'Viewed confirmed bookings sent for supervisor review.', true),
        requireRoles('supervisor', 'manager'), handle(async (req, res) => {
            await ensure();
            const [rows] = await dbp.query(`SELECT sr.*,r.sent_at,r.sent_version,r.reviewed_at,r.reviewed_version,r.notes,
                d.name AS driver_name,t.license_plate,u.name AS customer_name
                FROM supervisor_booking_reviews r JOIN service_requests sr ON sr.id=r.service_request_id
                LEFT JOIN drivers d ON d.id=sr.assigned_driver_id LEFT JOIN trucks t ON t.id=sr.assigned_truck_id
                LEFT JOIN users u ON u.id=sr.customer_id ORDER BY r.sent_at DESC`);
            res.json(rows.map(row => ({ id: row.id, customer_name: row.customer_name, cargo_type: row.cargo_type,
                pickup_location: row.pickup_location, delivery_location: row.delivery_location,
                pickup_date: row.pickup_date, preferred_time: row.preferred_time, driver_name: row.driver_name,
                license_plate: row.license_plate, quoted_amount: row.quoted_amount, status: row.status,
                ...reviewState(row, { sent_at: row.sent_at, sent_version: row.sent_version, reviewed_at: row.reviewed_at,
                    reviewed_version: row.reviewed_version, notes: row.notes }) })));
        }));
    app.put(handoff, audit('booking_review.reviewed', 'service_request', 'Reviewed a confirmed booking without blocking dispatch.'),
        requireRoles('supervisor', 'manager'), handle(async (req, res) => {
            await ensure();
            const bookingId = id(req.params.id);
            if (typeof req.body.notes !== 'string' || req.body.notes.length > 2000) throw new HttpError(400, 'Review notes must be 2,000 characters or fewer.');
            await withTransaction(async connection => {
                const row = await booking(connection, bookingId, true), current = version(row);
                const [[saved]] = await connection.query('SELECT * FROM supervisor_booking_reviews WHERE service_request_id=? FOR UPDATE', [bookingId]);
                if (!saved) throw new HttpError(404, 'This booking has not been sent for review.');
                if (!['approved', 'ongoing', 'completed'].includes(row.status)) throw new HttpError(409, 'This booking is no longer confirmed.');
                if (saved.sent_version !== current || req.body.version !== current) throw new HttpError(409, 'Booking details changed. Ask Dispatch to save and resend the booking, then refresh.');
                await connection.query('UPDATE supervisor_booking_reviews SET reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,reviewed_version=?,notes=? WHERE service_request_id=?',
                    [req.auth.sub, current, req.body.notes.trim(), bookingId]);
            });
            res.locals.auditEntityId = bookingId;
            res.json({ state: 'reviewed' });
        }));
    return { ensure };
};
module.exports.CATALOG = CATALOG;
module.exports.version = version;
module.exports.category = category;

module.exports.TABLES = TABLES;

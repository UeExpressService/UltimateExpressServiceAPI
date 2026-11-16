const TABLE = `CREATE TABLE IF NOT EXISTS service_request_payment_schedules (
    service_request_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    due_date DATE NOT NULL, notes VARCHAR(1000) NOT NULL DEFAULT '',
    scheduled_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX payment_due_date (due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

module.exports = function registerPaymentSchedules(app, { dbp, withTransaction, requireRoles, auditUserAction, HttpError, sendError }) {
    let ready;
    function ensure() {
        if (!ready) ready = dbp.query(TABLE).catch(error => { ready = null; throw error; });
        return ready;
    }
    const handle = work => async (req,res) => {
        res.setHeader('Cache-Control','no-store');
        try { await ensure(); await work(req,res); }
        catch (error) { sendError(res,error,'Unable to process the payment schedule.'); }
    };
    function bookingId(req) {
        const value = Number(req.params.id);
        if (!Number.isSafeInteger(value) || value <= 0) throw new HttpError(400,'Invalid booking ID.');
        return value;
    }
    function validDate(value) {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '2000-01-01' && value <= '2099-12-31' &&
            Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
    }
    const select = `SELECT sr.id,sr.status,sr.quoted_amount,sr.paid_amount,sr.paid_at,sr.pickup_location,sr.delivery_location,
        COALESCE(u.name,sr.contact_person,'Customer') AS customer_name,s.due_date,s.notes,s.updated_at,
        DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+08:00'),'%Y-%m-%d') AS today
        FROM service_requests sr LEFT JOIN service_request_payment_schedules s ON s.service_request_id=sr.id
        LEFT JOIN users u ON u.id=sr.customer_id`;
    function project(row) {
        const due = row.due_date;
        return { ...row, payment_status: row.paid_amount != null ? 'paid' : row.status === 'cancelled' ? 'cancelled' : !due ? 'not_scheduled' :
            due < row.today ? 'overdue' : due === row.today ? 'due_today' : 'upcoming' };
    }
    app.get('/api/payment-schedules', auditUserAction('payment_schedule.viewed','payment_schedule','Viewed scheduled payments.',true),
        requireRoles('manager','dispatcher'), handle(async (req,res) => {
            const [rows] = await dbp.query(select+' WHERE s.service_request_id IS NOT NULL ORDER BY s.due_date,sr.id');
            res.json(rows.map(project));
        }));
    const route = '/api/service-requests/:id/payment-schedule';
    app.get(route, auditUserAction('payment_schedule.viewed','service_request','Viewed a booking payment schedule.',true),
        requireRoles('manager','dispatcher'), handle(async (req,res) => {
            const [[row]] = await dbp.query(select+' WHERE sr.id=?',[bookingId(req)]);
            if (!row) throw new HttpError(404,'Booking not found.');
            res.json(project(row));
        }));
    app.put(route, auditUserAction('payment_schedule.updated','service_request','Updated a payment due date; no payment was recorded.'),
        requireRoles('dispatcher'), handle(async (req,res) => {
            const id = bookingId(req), body = req.body || {};
            if (body.due_date !== null && !validDate(body.due_date)) throw new HttpError(400,'Choose a valid payment due date between 2000 and 2099.');
            if (typeof body.notes !== 'string' || body.notes.length > 1000) throw new HttpError(400,'Payment notes must be 1,000 characters or fewer.');
            await withTransaction(async connection => {
                const [[row]] = await connection.query('SELECT status,paid_amount,quoted_amount FROM service_requests WHERE id=? FOR UPDATE',[id]);
                if (!row) throw new HttpError(404,'Booking not found.');
                if (row.paid_amount != null || row.status === 'cancelled') throw new HttpError(409,'Paid or cancelled bookings cannot have their payment schedule changed.');
                if (body.due_date === null) {
                    await connection.query('DELETE FROM service_request_payment_schedules WHERE service_request_id=?',[id]);
                    return;
                }
                if (!['approved','ongoing','completed'].includes(row.status) || !(Number(row.quoted_amount)>0)) throw new HttpError(409,'Save a confirmed booking with a dispatcher quote before scheduling payment.');
                await connection.query(`INSERT INTO service_request_payment_schedules (service_request_id,due_date,notes,scheduled_by) VALUES (?,?,?,?)
                    ON DUPLICATE KEY UPDATE due_date=VALUES(due_date),notes=VALUES(notes),scheduled_by=VALUES(scheduled_by)`,
                    [id,body.due_date,body.notes.trim(),req.auth.sub]);
            });
            res.locals.auditEntityId = id;
            res.json({ message: body.due_date === null ? 'Payment schedule removed.' : 'Payment schedule saved. No payment has been recorded.' });
        }));
    return { ensure };
};
module.exports.TABLE = TABLE;

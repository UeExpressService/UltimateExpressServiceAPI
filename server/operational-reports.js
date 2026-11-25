const crypto = require('node:crypto');
const path = require('node:path');
const { PDFDocument } = require('pdfkit');

const DAY = 86400000;
const TITLES = { payments: 'Transaction and Payment Report', bookings: 'Booking and Delivery Report', fleet: 'Fleet and Driver Activity Report' };

function validDate(value) {
    if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function period(query) {
    const { from, to } = query;
    if (!validDate(from) || !validDate(to)) throw Object.assign(new Error('Choose valid From and To dates between 2000 and 2099.'), { status: 400 });
    const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
    if (days < 1 || days > 366) throw Object.assign(new Error('Choose a period of 1 to 366 days, with From on or before To.'), { status: 400 });
    return { from, to, days };
}

function statusGroup(value) {
    const status = String(value || '').trim().toLowerCase();
    if (['', 'new', 'pending'].includes(status)) return 'Pending';
    if (['approved', 'ongoing'].includes(status)) return 'Ongoing';
    if (status === 'completed') return 'Completed';
    if (status === 'cancelled') return 'Cancelled';
    return 'Other';
}

function summarize(rows) {
    const counts = { Pending: 0, Ongoing: 0, Completed: 0, Cancelled: 0, Other: 0 };
    const monthly = new Map(), trucks = new Map(), drivers = new Map();
    let confirmed = 0, assigned = 0, missingTruck = 0, missingDriver = 0;
    for (const row of rows) {
        const status = statusGroup(row.status);
        counts[status]++;
        const month = row.report_date.slice(0, 7);
        if (!monthly.has(month)) monthly.set(month, { month, total: 0, completed: 0, ongoing: 0, pending: 0, cancelled: 0, other: 0 });
        const monthRow = monthly.get(month);
        monthRow.total++; monthRow[status.toLowerCase()]++;
        if (!['Ongoing', 'Completed'].includes(status)) continue;
        confirmed++;
        if (row.assigned_truck_id && row.assigned_driver_id) assigned++;
        if (!row.assigned_truck_id) missingTruck++;
        if (!row.assigned_driver_id) missingDriver++;
        for (const [map, id, name, extra] of [
            [trucks, row.assigned_truck_id, row.truck_plate, row.truck_type],
            [drivers, row.assigned_driver_id, row.driver_name, '']
        ]) {
            if (!id) continue;
            if (!map.has(id)) map.set(id, { id, name: name || `Record #${id} unavailable`, extra, assigned: 0, completed: 0, ongoing: 0 });
            const resource = map.get(id);
            resource.assigned++; resource[status.toLowerCase()]++;
        }
    }
    const rate = (done, total) => total ? Math.round(done / total * 10000) / 100 : null;
    const order = map => [...map.values()].sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name));
    return { total: rows.length, counts, completionRate: rate(counts.Completed, rows.length), confirmed,
        fullyAssigned: assigned, assignmentCoverage: rate(assigned, confirmed), missingTruck, missingDriver,
        monthly: [...monthly.values()].sort((a,b) => a.month.localeCompare(b.month)), trucks: order(trucks), drivers: order(drivers) };
}

async function loadReport(dbp, selectedPeriod, actorId, type = 'bookings') {
    const connection = dbp.getConnection ? await dbp.getConnection() : dbp;
    try {
        // Keep every section of the report on the same saved-record snapshot.
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION READ ONLY');
        const [rows] = await connection.query(`SELECT sr.id, sr.status, sr.assigned_truck_id, sr.assigned_driver_id,
            DATE_FORMAT(COALESCE(sr.pickup_date, sr.created_at), '%Y-%m-%d') AS report_date,
            CASE WHEN sr.pickup_date IS NULL THEN 'Created' ELSE 'Pickup' END AS date_basis,
            COALESCE(NULLIF(sr.contact_person, ''), u.name, 'Customer not recorded') AS customer_name,
            sr.pickup_location, sr.delivery_location, t.license_plate AS truck_plate, t.type AS truck_type,
            d.name AS driver_name${type === 'payments' ? ', sr.quoted_amount, sr.paid_amount, DATE_FORMAT(sr.paid_at, \'%Y-%m-%d\') AS paid_date' : ''}
            FROM service_requests sr LEFT JOIN users u ON u.id = sr.customer_id
            LEFT JOIN trucks t ON t.id = sr.assigned_truck_id LEFT JOIN drivers d ON d.id = sr.assigned_driver_id
            WHERE DATE(COALESCE(sr.pickup_date, sr.created_at)) BETWEEN ? AND ?
            ORDER BY report_date, sr.id LIMIT 5001`, [selectedPeriod.from, selectedPeriod.to]);
        if (rows.length > 5000) throw Object.assign(new Error('This period has over 5,000 bookings. Choose a shorter period.'), { status: 400 });
        const [[actor]] = await connection.query('SELECT name, role FROM users WHERE id = ? LIMIT 1', [actorId]);
        let payments = [];
        if (type === 'payments') {
            [payments] = await connection.query(`SELECT sr.id,
                COALESCE(NULLIF(sr.contact_person, ''), u.name, 'Customer not recorded') AS customer_name,
                DATE_FORMAT(sr.paid_at, '%Y-%m-%d %H:%i') AS paid_date, sr.paid_amount,
                DATE_FORMAT(sr.pickup_date, '%Y-%m-%d') AS pickup_date, sr.status
                FROM service_requests sr LEFT JOIN users u ON u.id = sr.customer_id
                WHERE sr.paid_amount IS NOT NULL AND sr.paid_at >= ? AND sr.paid_at < DATE_ADD(?, INTERVAL 1 DAY)
                ORDER BY sr.paid_at, sr.id LIMIT 5001`, [selectedPeriod.from, selectedPeriod.to]);
            if (payments.length > 5000) throw Object.assign(new Error('This period has over 5,000 payments. Choose a shorter period.'), { status: 400 });
        }
        const report = { period: selectedPeriod, rows, payments, summary: summarize(rows), preparedBy: actor?.name || 'Staff', role: actor?.role || 'Staff', generatedAt: new Date() };
        await connection.commit();
        return report;
    } catch (error) { await connection.rollback(); throw error; }
    finally { if (connection !== dbp) connection.release(); }
}

function renderPDF(report, type) {
    return new Promise((resolve, reject) => {
        const title = TITLES[type];
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40, bufferPages: true,
            info: { Title: title, Author: 'Ultimate Express Trans Logistic Corporation', Subject: `${report.period.from} to ${report.period.to}` } });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
        const width = doc.page.width - 80, bottom = doc.page.height - 55;
        const reference = `UE-${{payments:'TPR',bookings:'BDR',fleet:'FDA'}[type]}-${report.generatedAt.toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const generated = report.generatedAt.toLocaleString('en-PH', { timeZone: 'Asia/Manila', hour12: true });
        let y;
        const clean = value => String(value ?? 'Not recorded').replace(/[\x00-\x08\x0b-\x1f]/g, ' ');
        function text(value, x, top, options = {}) {
            doc.fillColor('#17231b').text(clean(value), x, top, { lineGap: 2, ...options });
        }
        function page() {
            doc.image(path.join(__dirname, '../Latest Update/images/logo.jpg'), 40, 30, { fit: [40, 40] });
            doc.font('Helvetica-Bold').fontSize(13); text('ULTIMATE EXPRESS', 90, 32, { width: width - 50 });
            doc.font('Helvetica').fontSize(9); text('Trans Logistic Corporation', 90, 49, { width: width - 50 });
            doc.font('Helvetica-Bold').fontSize(19); text(title, 40, 82, { width });
            doc.font('Helvetica').fontSize(9);
            text(`Reporting period: ${report.period.from} to ${report.period.to} (inclusive)`, 40, 110, { width: width / 2 });
            text(`Report ID: ${reference}`, 40 + width / 2, 110, { width: width / 2, align: 'right' });
            text(`Generated: ${generated} PHT`, 40, 126, { width: width / 2 });
            text(`Prepared by: ${report.preparedBy} (${report.role})`, 40 + width / 2, 126, { width: width / 2, height: 15, ellipsis: true, align: 'right' });
            y = 157;
        }
        function nextPage() { doc.addPage(); page(); }
        function space(height) { if (y + height > bottom) nextPage(); }
        function paragraph(value) {
            doc.font('Helvetica').fontSize(9);
            const h = doc.heightOfString(clean(value), { width, lineGap: 2 }); space(h + 12);
            text(value, 40, y, { width }); y += h + 12;
        }
        function heading(value) { space(74); doc.font('Helvetica-Bold').fontSize(12); text(value, 40, y, { width }); y += 24; }
        function table(columns, rows, weights) {
            if (!rows.length) { paragraph('No records for this reporting period.'); return; }
            const sum = weights.reduce((a,b) => a+b,0), widths = weights.map(w => w / sum * width);
            function height(values) {
                return Math.max(25, ...values.map((v,i) => doc.heightOfString(clean(v), { width: widths[i] - 12, lineGap: 2 }) + 12));
            }
            function row(values, header = false, index = 0) {
                doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
                const h = height(values);
                let x = 40;
                values.forEach((value,i) => {
                    doc.rect(x, y, widths[i], h).fillAndStroke(header ? '#e8eee9' : index % 2 ? '#f7f9f7' : '#ffffff', '#ced7d0');
                    doc.fillColor('#17231b'); text(value, x + 6, y + 6, { width: widths[i] - 12 }); x += widths[i];
                });
                y += h;
            }
            doc.font('Helvetica-Bold').fontSize(9);
            const headerHeight = height(columns);
            space(headerHeight + 30); row(columns, true);
            rows.forEach((values,index) => {
                doc.font('Helvetica').fontSize(9);
                const remaining = values.map(clean);
                // Long saved addresses can continue onto another page without clipping.
                do {
                    const maxTextHeight = bottom - 157 - headerHeight - 12;
                    const fragment = remaining.map((value,i) => {
                        let lo = 0, hi = value.length;
                        while (lo < hi) {
                            const mid = Math.ceil((lo + hi) / 2);
                            if (doc.heightOfString(value.slice(0,mid), { width: widths[i] - 12, lineGap: 2 }) <= maxTextHeight) lo = mid;
                            else hi = mid - 1;
                        }
                        const part = value.slice(0,lo);
                        remaining[i] = value.slice(lo);
                        return part;
                    });
                    const h = height(fragment);
                    if (y + h > bottom) { nextPage(); row(columns, true); doc.font('Helvetica').fontSize(9); }
                    row(fragment, false, index);
                } while (remaining.some(Boolean));
            });
            y += 16;
        }
        const s = report.summary;
        try {
            page();
            heading('Operational summary');
            if (type === 'payments') {
                const money = cents => `PHP ${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                const cents = value => Math.round(Number(value || 0) * 100);
                const paid = report.payments.reduce((sum,r) => sum + cents(r.paid_amount), 0);
                const confirmed = report.rows.filter(r => ['Ongoing','Completed'].includes(statusGroup(r.status)) && Number(r.quoted_amount) > 0);
                const quotes = confirmed.reduce((sum,r) => sum + cents(r.quoted_amount), 0);
                const unpaid = confirmed.filter(r => r.paid_amount === null).reduce((sum,r) => sum + cents(r.quoted_amount), 0);
                table(['Summary', 'Total'], [
                    ['Bookings in the selected period', s.total],
                    ['Completed bookings', s.counts.Completed],
                    ['Confirmed quotes', money(quotes)],
                    ['Unpaid confirmed quotes', money(unpaid)],
                    ['Recorded payments in the period', money(paid)],
                    ['Paid bookings in the period', report.payments.length],
                    ['Average recorded payment', report.payments.length ? money(Math.round(paid / report.payments.length)) : 'N/A']
                ], [3,2]);
                nextPage(); heading('Booking transaction details');
                table(['Booking', 'Booking date', 'Customer', 'Status', 'Saved quote', 'Payment status'], report.rows.map(r => [
                    `REQ-${r.id}`, r.report_date, r.customer_name, statusGroup(r.status),
                    r.quoted_amount === null ? 'Not quoted' : money(cents(r.quoted_amount)),
                    r.paid_amount === null ? 'Not recorded' : r.paid_date ? `Recorded ${r.paid_date}${r.paid_date < report.period.from || r.paid_date > report.period.to ? ' (outside period)' : ''}` : 'Payment date not recorded'
                ]), [0.9,1.3,2,1.1,1.3,2.2]);
                heading('Payments recorded within the selected period');
                table(['Booking', 'Customer', 'Payment recorded (PHT)', 'Paid amount', 'Pickup date', 'Current status'], report.payments.map(r => [
                    `REQ-${r.id}`, r.customer_name, r.paid_date, money(cents(r.paid_amount)), r.pickup_date || 'Not recorded', statusGroup(r.status)
                ]), [0.9,2,1.8,1.4,1.2,1.2]);
            } else if (type === 'bookings') {
                table(['Summary', 'Total'], [
                    ['Total bookings', s.total],
                    ...Object.entries(s.counts).map(([label,total]) => [label, total])
                ], [3,2]);
                heading('Monthly booking breakdown');
                table(['Month', 'Bookings', 'Completed', 'Ongoing', 'Pending', 'Cancelled', 'Other'], s.monthly.map(r => [r.month,r.total,r.completed,r.ongoing,r.pending,r.cancelled,r.other]), [1.3,1,1,1,1,1,1]);
                nextPage(); heading('Booking and delivery register');
                table(['Booking', 'Booking date', 'Customer', 'Pickup', 'Delivery', 'Driver / truck', 'Status'], report.rows.map(r => [
                    `REQ-${r.id}`, r.report_date, r.customer_name, r.pickup_location, r.delivery_location,
                    `${r.driver_name || 'Driver not assigned'}\n${r.truck_plate || 'Truck not assigned'}`, statusGroup(r.status) === 'Other' ? `Other: ${r.status}` : statusGroup(r.status)
                ]), [0.8,1.1,1.4,1.8,1.8,1.6,1]);
            } else {
                table(['Summary', 'Total'], [
                    ['Confirmed trip bookings', s.confirmed],
                    ['Trucks with assigned trips', s.trucks.length],
                    ['Drivers with assigned trips', s.drivers.length],
                    ['Completed trip bookings', s.counts.Completed],
                    ['Without a truck assignment', s.missingTruck],
                    ['Without a driver assignment', s.missingDriver],
                    ['Bookings with a truck and driver', s.fullyAssigned]
                ], [3,2]);
                heading('Truck trip activity');
                table(['Truck', 'Truck type', 'Assigned trips', 'Completed', 'Ongoing'], s.trucks.map(r => [r.name,r.extra,r.assigned,r.completed,r.ongoing]), [1.5,2.2,1,1,1]);
                heading('Driver trip activity');
                table(['Driver', 'Assigned trips', 'Completed', 'Ongoing'], s.drivers.map(r => [r.name,r.assigned,r.completed,r.ongoing]), [3,1,1,1]);
                nextPage(); heading('Assignment register for confirmed trips');
                table(['Booking', 'Booking date', 'Driver', 'Truck', 'Truck type', 'Status'], report.rows.filter(r => ['Ongoing','Completed'].includes(statusGroup(r.status))).map(r => [
                    `REQ-${r.id}`, r.report_date, r.driver_name || 'Not assigned', r.truck_plate || 'Not assigned', r.truck_type || 'Not recorded', statusGroup(r.status)
                ]), [0.9,1.3,2,1.4,2,1]);
            }
            const pages = doc.bufferedPageRange();
            for (let i = 0; i < pages.count; i++) {
                doc.switchToPage(i); doc.font('Helvetica').fontSize(8);
                const bottomMargin = doc.page.margins.bottom;
                doc.page.margins.bottom = 0;
                text(`${reference} | ${report.period.from} to ${report.period.to}`, 40, doc.page.height - 32, { width: width - 90, lineBreak: false });
                text(`Page ${i + 1} of ${pages.count}`, doc.page.width - 130, doc.page.height - 32, { width: 90, align: 'right', lineBreak: false });
                doc.page.margins.bottom = bottomMargin;
            }
            doc.end();
        } catch (error) { doc.destroy(error); reject(error); }
    });
}

function register(app, { dbp, requireRoles, sendError, rateLimit }) {
    const access = requireRoles('manager', 'supervisor');
    const limit = rateLimit({ windowMs: 60000, max: 15, message: 'Please wait a minute before generating more reports.' });
    app.get('/api/reports/:type.pdf', access, limit, async (req, res) => {
        if (!Object.hasOwn(TITLES, req.params.type)) return res.status(404).json({ error: 'Report type not found.' });
        if (req.params.type === 'payments' && req.auth.role !== 'manager') return res.status(403).json({ error: 'Only a Manager can generate payment reports.' });
        try {
            const selected = period(req.query);
            res.locals.auditSummary = `Generated ${TITLES[req.params.type]} for ${selected.from} to ${selected.to}.`;
            const report = await loadReport(dbp, selected, req.auth.sub, req.params.type);
            const pdf = await renderPDF(report, req.params.type);
            res.set('Cache-Control', 'private, no-store');
            res.set('Content-Type', 'application/pdf');
            res.set('Content-Disposition', `attachment; filename="ultimate-express-${req.params.type}-${selected.from}-to-${selected.to}.pdf"`);
            res.send(pdf);
        } catch (error) {
            if (error.status === 400) return res.status(400).json({ error: error.message });
            sendError(res, error, 'Unable to generate the operational report.');
        }
    });
}

module.exports = { register, period, statusGroup, summarize, loadReport, renderPDF, TITLES };

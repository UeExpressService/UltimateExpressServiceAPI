const crypto = require('node:crypto');
const path = require('node:path');
const { PDFDocument } = require('pdfkit');

const DAY = 86400000;
const TITLES = { payments: 'Management Report', bookings: 'Booking and Delivery Report', fleet: 'Fleet and Driver Activity Report',
    drivers: 'Drivers in Trips', newdrivers: 'New Drivers', newtrucks: 'New Trucks', customertrucks: 'Trucks Assigned to Customer Trips' };
const FLEET_TYPES = ['fleet', 'drivers', 'newdrivers', 'newtrucks', 'customertrucks'];

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
        let newDrivers = [], newTrucks = [];
        if (FLEET_TYPES.includes(type)) {
            [newDrivers] = await connection.query(`SELECT id, name, license_number, phone,
                DATE_FORMAT(created_at, '%Y-%m-%d') AS added_date FROM drivers
                WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
                ORDER BY created_at, id LIMIT 5001`, [selectedPeriod.from, selectedPeriod.to]);
            [newTrucks] = await connection.query(`SELECT id, license_plate, type, capacity,
                DATE_FORMAT(created_at, '%Y-%m-%d') AS added_date FROM trucks
                WHERE created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)
                ORDER BY created_at, id LIMIT 5001`, [selectedPeriod.from, selectedPeriod.to]);
            if (newDrivers.length > 5000 || newTrucks.length > 5000) throw Object.assign(new Error('This period has over 5,000 new fleet records. Choose a shorter period.'), { status: 400 });
        }
        const report = { period: selectedPeriod, rows, payments, newDrivers, newTrucks, summary: summarize(rows), preparedBy: actor?.name || 'Staff', role: actor?.role || 'Staff', generatedAt: new Date() };
        await connection.commit();
        return report;
    } catch (error) { await connection.rollback(); throw error; }
    finally { if (connection !== dbp) connection.release(); }
}

function renderPDF(report, type) {
    return new Promise((resolve, reject) => {
        const title = TITLES[type];
        const doc = new PDFDocument({ size: 'A4', layout: type === 'payments' ? 'portrait' : 'landscape', margin: 40, bufferPages: true,
            info: { Title: title, Author: 'Ultimate Express Trans Logistic Corporation', Subject: `${report.period.from} to ${report.period.to}` } });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
        const width = doc.page.width - 80, bottom = doc.page.height - 55;
        const reference = `UE-${{payments:'TPR',bookings:'BDR',fleet:'FDA',drivers:'DIT',newdrivers:'NDR',newtrucks:'NTR',customertrucks:'CTT'}[type]}-${report.generatedAt.toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        let y, section = 0;
        const navy = '#093b5d', green = '#75b72d', lightBlue = '#e8f2f9', lightGreen = '#edf6e7';
        const date = value => new Date(value + 'T00:00:00Z').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        const clean = value => String(value ?? 'Not recorded').replace(/[\x00-\x08\x0b-\x1f]/g, ' ');
        function text(value, x, top, options = {}) {
            doc.fillColor('#17231b').text(clean(value), x, top, { lineGap: 2, ...options });
        }
        function page() {
            doc.save().polygon([doc.page.width-190,0],[doc.page.width,0],[doc.page.width,50]).fill(navy);
            doc.polygon([doc.page.width-190,5],[doc.page.width,55],[doc.page.width,62]).fill(green).restore();
            doc.image(path.join(__dirname, '../Latest Update/images/logo.jpg'), 40, 24, { fit: [40, 40] });
            doc.font('Helvetica-Bold').fontSize(18); text('ULTIMATE EXPRESS', 90, 28, { width: width - 50, fill: '#061b34' });
            doc.font('Helvetica').fontSize(10); text('Trans Logistic Corporation', 90, 49, { width: width - 50 });
            doc.moveTo(40,76).lineTo(doc.page.width-40,76).lineWidth(1.5).stroke(green);
            doc.font('Helvetica-Bold').fontSize(type === 'payments' ? 23 : 20); text(title.toUpperCase(), 40, 88, { width });
            doc.font('Helvetica').fontSize(10); text(type === 'payments' ? 'Monthly Operations and Transactions Summary' : 'Operations and Activity Summary',40,116,{width});
            doc.fontSize(8);
            text(`Reporting period: ${date(report.period.from)} - ${date(report.period.to)}`,40,139,{width:width*.7});
            text(`Generated: ${report.generatedAt.toLocaleDateString('en-PH',{timeZone:'Asia/Manila'})}`,40+width*.7,139,{width:width*.3,align:'right'});
            y = 163;
        }
        function nextPage() { doc.addPage(); page(); }
        function space(height) { if (y + height > bottom) nextPage(); }
        function paragraph(value) {
            doc.font('Helvetica').fontSize(9);
            const h = doc.heightOfString(clean(value), { width, lineGap: 2 }); space(h + 12);
            text(value, 40, y, { width }); y += h + 12;
        }
        function heading(value) {
            space(80); section++;
            doc.save().polygon([33,y],[42,y],[34,y+20],[25,y+20]).fill(green);
            doc.roundedRect(40,y,width,20,2).fill(navy).restore();
            doc.font('Helvetica-Bold').fontSize(10).fillColor('white').text(`${section}.  ${value.toUpperCase()}`,48,y+5,{width:width-16,lineBreak:false});
            y += 28;
        }
        function table(columns, rows, weights) {
            if (!rows.length) { paragraph('No records for this reporting period.'); return; }
            const sum = weights.reduce((a,b) => a+b,0), widths = weights.map(w => w / sum * width);
            const fontSize = columns.length > 7 ? 7 : 9;
            const minimumHeight = type === 'payments' ? 21 : 25;
            function height(values) {
                return Math.max(minimumHeight, ...values.map((v,i) => doc.heightOfString(clean(v), { width: widths[i] - 10, lineGap: 2 }) + 10));
            }
            function row(values, header = false, index = 0) {
                const total = values[0] === 'TOTAL';
                doc.font(header || total ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
                const h = height(values);
                let x = 40;
                values.forEach((value,i) => {
                    doc.rect(x, y, widths[i], h).fillAndStroke(header ? '#cce2f2' : total ? '#deedcb' : index % 2 ? '#f5f8fa' : '#ffffff', '#b4c5cf');
                    if (!header && columns[i] === 'Status' && ['Completed','Pending','Ongoing','Cancelled'].includes(value)) {
                        doc.roundedRect(x+3,y+4,widths[i]-6,Math.min(h-8,18),3).fill({Completed:'#deefd6',Pending:'#fff2bd',Ongoing:'#dcecf9',Cancelled:'#f6dddd'}[value]);
                    }
                    text(value, x + 5, y + 5, { width: widths[i] - 10 }); x += widths[i];
                });
                y += h;
            }
            doc.font('Helvetica-Bold').fontSize(fontSize);
            const headerHeight = height(columns);
            space(headerHeight + 30); row(columns, true);
            rows.forEach((values,index) => {
                doc.font('Helvetica').fontSize(fontSize);
                const remaining = values.map(clean);
                // Long saved addresses can continue onto another page without clipping.
                do {
                    const maxTextHeight = bottom - 163 - headerHeight - 12;
                    const fragment = remaining.map((value,i) => {
                        let lo = 0, hi = value.length;
                        while (lo < hi) {
                            const mid = Math.ceil((lo + hi) / 2);
                            if (doc.heightOfString(value.slice(0,mid), { width: widths[i] - 10, lineGap: 2 }) <= maxTextHeight) lo = mid;
                            else hi = mid - 1;
                        }
                        const part = value.slice(0,lo);
                        remaining[i] = value.slice(lo);
                        return part;
                    });
                    const h = height(fragment);
                    if (y + h > bottom) { nextPage(); row(columns, true); doc.font('Helvetica').fontSize(fontSize); }
                    row(fragment, false, index);
                } while (remaining.some(Boolean));
            });
            y += 16;
        }
        const s = report.summary;
        try {
            page();
            if (!FLEET_TYPES.includes(type) || type === 'fleet') heading(type === 'payments' ? 'Executive summary' : 'Operational summary');
            if (type === 'payments') {
                const money = cents => `PHP ${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                const cents = value => Math.round(Number(value || 0) * 100);
                const paid = report.payments.reduce((sum,r) => sum + cents(r.paid_amount), 0);
                const confirmed = report.rows.filter(r => ['Ongoing','Completed'].includes(statusGroup(r.status)) && Number(r.quoted_amount) > 0);
                const quotes = confirmed.reduce((sum,r) => sum + cents(r.quoted_amount), 0);
                const unpaid = confirmed.filter(r => r.paid_amount === null).reduce((sum,r) => sum + cents(r.quoted_amount), 0);
                const cards=[['Total Bookings',s.total],['Completed Trips',s.counts.Completed],['Pending Trips',s.counts.Pending],['Cancelled Trips',s.counts.Cancelled],['Confirmed Quotes',money(quotes)],['Total Collected',money(paid)]];
                const cardWidth=(width-25)/6;
                space(66);
                cards.forEach(([label,value],i)=>{
                    const x=40+i*(cardWidth+5);
                    doc.roundedRect(x,y,cardWidth,60,4).fill(i%2?lightGreen:lightBlue);
                    doc.font('Helvetica-Bold').fontSize(8); text(label,x+5,y+9,{width:cardWidth-10,align:'center'});
                    let size=13; doc.fontSize(size);
                    while(size>7 && doc.widthOfString(String(value))>cardWidth-10)doc.fontSize(--size);
                    text(value,x+5,y+36,{width:cardWidth-10,align:'center',lineBreak:false});
                });
                y+=74;
                heading('Monthly operations summary');
                const weeks=new Map();
                function weekFor(value){
                    const month=value.slice(0,7),day=Number(value.slice(8)),bucket=Math.min(3,Math.floor((day-1)/7));
                    const key=month+'-'+bucket;
                    if(!weeks.has(key)){
                        const last=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
                        const from=month+'-'+String(bucket*7+1).padStart(2,'0'),to=month+'-'+String(bucket===3?last:bucket*7+7).padStart(2,'0');
                        weeks.set(key,{label:`${date(from<report.period.from?report.period.from:from)} - ${date(to>report.period.to?report.period.to:to)}`,total:0,Pending:0,Ongoing:0,Completed:0,Cancelled:0,Other:0});
                    }
                    return weeks.get(key);
                }
                for(let time=Date.parse(report.period.from);time<=Date.parse(report.period.to);time+=DAY)weekFor(new Date(time).toISOString().slice(0,10));
                for(const row of report.rows){const week=weekFor(row.report_date);week.total++;week[statusGroup(row.status)]++;}
                const weeklyColumns=['Period','Bookings','Completed','Ongoing','Pending','Cancelled',...(s.counts.Other?['Other']:[])];
                const weeklyRows=[...weeks.values()].map(w=>[w.label,w.total,w.Completed,w.Ongoing,w.Pending,w.Cancelled,...(s.counts.Other?[w.Other]:[])]);
                weeklyRows.push(['TOTAL',s.total,s.counts.Completed,s.counts.Ongoing,s.counts.Pending,s.counts.Cancelled,...(s.counts.Other?[s.counts.Other]:[])]);
                table(weeklyColumns,weeklyRows,[3,1,1,1,1,1,...(s.counts.Other?[1]:[])]);
                heading('Detailed monthly transactions');
                table(['Booking ID','Date','Customer','Pickup','Delivery','Truck','Driver','Status','Quote (PHP)'], report.rows.map(r=>[
                    `REQ-${r.id}`,r.report_date,r.customer_name,r.pickup_location,r.delivery_location,r.truck_plate||'Not assigned',r.driver_name||'Not assigned',statusGroup(r.status),
                    r.quoted_amount===null?'Not quoted':(cents(r.quoted_amount)/100).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})
                ]),[1,1.1,1.6,1.5,1.5,1.1,1.3,1.2,1.3]);
                heading('Payments and quotations summary');
                table(['Category','Amount (PHP)'],[
                    ['Confirmed quotations',money(quotes)],['Unpaid confirmed quotations',money(unpaid)],['Total collected in the period',money(paid)],
                    ['Average recorded payment',report.payments.length?money(Math.round(paid/report.payments.length)):'N/A']
                ],[3,2]);
                doc.font('Helvetica-Bold').fontSize(9);space(45);text('Payments recorded during the reporting period',40,y,{width});y+=18;
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
                if (type === 'fleet') table(['Summary', 'Total'], [
                    ['Confirmed trip bookings', s.confirmed],
                    ['Trucks with assigned trips', s.trucks.length],
                    ['Drivers with assigned trips', s.drivers.length],
                    ['Completed trip bookings', s.counts.Completed],
                    ['Without a truck assignment', s.missingTruck],
                    ['Without a driver assignment', s.missingDriver],
                    ['Bookings with a truck and driver', s.fullyAssigned],
                    ['New drivers', (report.newDrivers || []).length],
                    ['New trucks', (report.newTrucks || []).length]
                ], [3,2]);
                const trips = report.rows.filter(r => ['Ongoing','Completed'].includes(statusGroup(r.status)));
                if (['fleet','drivers'].includes(type)) {
                    heading('Drivers in trips');
                    table(['Driver', 'Trips', 'Completed', 'Ongoing'], s.drivers.map(r => [r.name,r.assigned,r.completed,r.ongoing]), [3,1,1,1]);
                    table(['Driver','Booking','Booking date','Customer','Truck','Pickup','Delivery','Status'], trips.filter(r => r.assigned_driver_id).map(r => [
                        r.driver_name || `Driver #${r.assigned_driver_id}`,`REQ-${r.id}`,r.report_date,r.customer_name,r.truck_plate || 'Not assigned',r.pickup_location,r.delivery_location,statusGroup(r.status)
                    ]), [1.4,.8,1.1,1.5,1.1,1.8,1.8,1]);
                }
                if (['fleet','newdrivers'].includes(type)) {
                    heading('New drivers');
                    table(['Driver','License number','Contact number','Date added'], (report.newDrivers || []).map(r => [r.name,r.license_number,r.phone || 'Not recorded',r.added_date]), [2.5,2,1.5,1.3]);
                }
                if (['fleet','newtrucks'].includes(type)) {
                    heading('New trucks');
                    table(['Plate number','Truck type','Capacity (kg)','Date added'], (report.newTrucks || []).map(r => [r.license_plate,r.type,r.capacity || 'Not recorded',r.added_date]), [1.5,2.5,1.4,1.3]);
                }
                if (['fleet','customertrucks'].includes(type)) {
                    heading('Trucks assigned to customer trips');
                    table(['Truck','Truck type','Booking','Booking date','Customer','Pickup','Delivery','Driver','Status'], trips.filter(r => r.assigned_truck_id).map(r => [
                        r.truck_plate || `Truck #${r.assigned_truck_id}`,r.truck_type || 'Not recorded',`REQ-${r.id}`,r.report_date,r.customer_name,r.pickup_location,r.delivery_location,r.driver_name || 'Not assigned',statusGroup(r.status)
                    ]), [1.1,1.2,.8,1.1,1.5,1.8,1.8,1.4,1]);
                }
            }
            space(80);
            const signatureWidth=(width-35)/2;
            doc.font('Helvetica').fontSize(9);text('Prepared by:',40,y,{width:signatureWidth});text('Approved by:',75+signatureWidth,y,{width:signatureWidth});
            doc.moveTo(40,y+35).lineTo(40+signatureWidth,y+35).stroke('#33434f');
            doc.moveTo(75+signatureWidth,y+35).lineTo(40+width,y+35).stroke('#33434f');
            doc.font('Helvetica-Bold').fontSize(9);text(report.preparedBy,40,y+40,{width:signatureWidth,height:15,ellipsis:true});
            doc.font('Helvetica').fontSize(8);text(report.role,40,y+55,{width:signatureWidth});
            const pages = doc.bufferedPageRange();
            for (let i = 0; i < pages.count; i++) {
                doc.switchToPage(i); doc.font('Helvetica').fontSize(8);
                const bottomMargin = doc.page.margins.bottom;
                doc.page.margins.bottom = 0;
                doc.save().polygon([0,doc.page.height-15],[0,doc.page.height-5],[doc.page.width,doc.page.height],[doc.page.width*.55,doc.page.height]).fill(green);
                doc.polygon([0,doc.page.height-5],[doc.page.width,doc.page.height-16],[doc.page.width,doc.page.height],[0,doc.page.height]).fill(navy).restore();
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

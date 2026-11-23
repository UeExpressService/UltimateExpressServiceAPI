// External references are identified separately from company-maintained tariffs.
const SOURCE = 'https://www.lalamove.com/en-ph/all-delivery-pricing-detail';
// Sample rates until the company supplies its approved prices.
const PROVISIONAL_RATES = [
    { id:'sample-l300', truck_type:'4-Wheeler L300', base_fare:5000, per_km:40 },
    { id:'sample-6van', truck_type:'6-Wheeler Closed Van', base_fare:12000, per_km:65 },
    { id:'sample-6drop', truck_type:'6-Wheeler Dropside', base_fare:20000, per_km:70 },
    { id:'sample-10wing', truck_type:'10-Wheeler Wing Van', base_fare:18000, per_km:95 },
    { id:'sample-trailer', truck_type:'Trailer Truck', base_fare:30000, per_km:130 }
].map(row => ({ ...row, label:row.truck_type, included_km:40, max_km:10000, provisional:true,
    notes:'Provisional sample pricing, not approved company rates. First 40 round-trip km included. Tolls, ferry, handling and other agreed charges are entered separately. No automatic tax or cargo surcharge.' }));
const MARKET_RATES = [
    { id: 'market-3t', label: 'Lalamove regular delivery · 3,000 kg 6W aluminum van', base_fare: 1450, per_km: 33 },
    { id: 'market-5t', label: 'Lalamove regular delivery · 5,000 kg 6W large aluminum van', base_fare: 2694, per_km: 34 },
    { id: 'market-12t', label: 'Lalamove regular delivery · 12,000 kg 10W wing van', base_fare: 7200, per_km: 85 }
].map(row => ({ ...row, included_km: 0, max_km: 50, source_url: SOURCE, reference_date: '2026-11-18', market_reference: true,
    notes: 'Published regular-delivery reference only. Confirm the carrier service area. Not a national tariff or an approved Ultimate Express rate. Tolls, waiting, ferry and other charges need separate review. Limited to 50 km here; use a company tariff for longer trips.' }));
function calculate(rate, distance, extras) {
    const number = value => typeof value === 'number' && Number.isFinite(value);
    if (!number(distance) || distance <= 0 || distance > Number(rate.max_km) || !number(extras) || extras < 0 || extras > 10000000) return null;
    const chargeable_km = Math.max(0, distance - Number(rate.included_km));
    const total = Math.round((Number(rate.base_fare) + chargeable_km * Number(rate.per_km) + extras) * 100) / 100;
    return total > 0 && total < 10000000000 ? { base_fare: Number(rate.base_fare), chargeable_km,
        distance_charge: Math.round(chargeable_km * Number(rate.per_km) * 100) / 100, extras, total } : null;
}
function registerRoutePricing(app, { dbp, requireRoles, auditUserAction, HttpError, sendError }) {
    let ready;
    function ensure() {
        if (!ready) ready = dbp.query(`CREATE TABLE IF NOT EXISTS route_rates (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, label VARCHAR(200) NOT NULL,
            base_fare DECIMAL(12,2) NOT NULL, included_km DECIMAL(10,2) NOT NULL DEFAULT 0,
            per_km DECIMAL(12,2) NOT NULL, max_km DECIMAL(10,2) NOT NULL,
            notes VARCHAR(1000) NOT NULL DEFAULT '', active TINYINT(1) NOT NULL DEFAULT 1,
            updated_by BIGINT UNSIGNED NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(error => { ready = undefined; throw error; });
        return ready;
    }
    const handler = work => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { await ensure(); await work(req, res); } catch (error) { sendError(res, error, 'Unable to process route pricing.'); }
    };
    app.get('/api/route-rates', requireRoles('manager','dispatcher'), auditUserAction('route_rates.viewed','route_rate','Viewed company tariffs and external pricing references.',true), handler(async (req,res) => {
        const [rows] = await dbp.query('SELECT * FROM route_rates ORDER BY label,id');
        res.json({ company: rows, market: MARKET_RATES, provisional: PROVISIONAL_RATES });
    }));
    const save = async (req,res) => {
        const body = req.body || {}, label = String(body.label || '').trim();
        const valid = key => typeof body[key] === 'number' && Number.isFinite(body[key]) && body[key] >= 0 && Math.abs(body[key]*100-Math.round(body[key]*100)) < 1e-7;
        if (!label || label.length > 200 || !['base_fare','included_km','per_km','max_km'].every(valid) ||
            body.base_fare > 10000000 || body.per_km > 1000000 || body.max_km <= 0 || body.max_km > 10000 || body.included_km > body.max_km ||
            typeof body.notes !== 'string' || body.notes.length > 1000 || typeof body.active !== 'boolean' || (body.base_fare === 0 && body.per_km === 0)) {
            throw new HttpError(400,'Enter a tariff name, valid non-negative amounts, a maximum distance up to 10,000 km, and notes up to 1,000 characters.');
        }
        const values = [label,body.base_fare,body.included_km,body.per_km,body.max_km,body.notes.trim(),body.active?1:0,req.auth.sub];
        if (req.params.id) {
            const id = Number(req.params.id);
            if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400,'Invalid tariff ID.');
            const [result] = await dbp.query('UPDATE route_rates SET label=?,base_fare=?,included_km=?,per_km=?,max_km=?,notes=?,active=?,updated_by=? WHERE id=?',[...values,id]);
            if (!result.affectedRows) throw new HttpError(404,'Tariff not found.');
            res.json({ message:'Company tariff updated.' });
        } else {
            const [result] = await dbp.query('INSERT INTO route_rates (label,base_fare,included_km,per_km,max_km,notes,active,updated_by) VALUES (?,?,?,?,?,?,?,?)',values);
            res.locals.auditEntityId = result.insertId; res.status(201).json({ id:result.insertId, message:'Company tariff created.' });
        }
    };
    app.post('/api/route-rates', requireRoles('manager'), auditUserAction('route_rate.created','route_rate','Created a company route tariff.'), handler(save));
    app.put('/api/route-rates/:id', requireRoles('manager'), auditUserAction('route_rate.updated','route_rate','Updated a company route tariff.'), handler(save));
    app.post('/api/route-estimates', requireRoles('dispatcher','manager'), auditUserAction('route_estimate.calculated','route_rate','Calculated a draft route estimate.'), handler(async (req,res) => {
        const body = req.body || {};
        let rate = [...PROVISIONAL_RATES, ...MARKET_RATES].find(rate => rate.id === body.rate_id);
        if (!rate) {
            const id = Number(body.rate_id);
            if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400,'Choose a rate reference.');
            const [[row]] = await dbp.query('SELECT * FROM route_rates WHERE id=? AND active=1',[id]); rate = row;
        }
        if (!rate) throw new HttpError(404,'Active company tariff not found.');
        const result = calculate(rate,body.distance_km,body.extras);
        if (!result) throw new HttpError(400,`Enter a route distance above zero and no greater than ${rate.max_km} km, with valid additional charges. Choose a company tariff for routes outside a market reference range.`);
        res.json({ ...result, rate_id:rate.id, label:rate.label, market_reference:!!rate.market_reference, provisional:!!rate.provisional,
            included_km:Number(rate.included_km), per_km:Number(rate.per_km), distance_km:body.distance_km,
            notes:rate.notes, source_url:rate.source_url || null, reference_date:rate.reference_date || null,
            message:'Draft estimate only. Dispatch must review and save the final quote; recorded payments are unchanged.' });
    }));
}
module.exports = registerRoutePricing;
module.exports.calculate = calculate;
module.exports.MARKET_RATES = MARKET_RATES;
module.exports.PROVISIONAL_RATES = PROVISIONAL_RATES;

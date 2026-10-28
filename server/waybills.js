const express = require('express');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 10;
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS service_request_waybills (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    service_request_id BIGINT UNSIGNED NOT NULL,
    uploaded_by BIGINT UNSIGNED NOT NULL,
    filename VARCHAR(180) NOT NULL,
    content_type VARCHAR(32) NOT NULL,
    byte_size INT UNSIGNED NOT NULL,
    content LONGBLOB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_waybills_request (service_request_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

function identifyFile(buffer) {
    if (buffer.subarray(0, 5).toString() === '%PDF-') return { type: 'application/pdf', extensions: ['pdf'] };
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { type: 'image/png', extensions: ['png'] };
    if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { type: 'image/jpeg', extensions: ['jpg', 'jpeg'] };
    return null;
}

module.exports = function registerWaybills(app, { dbp, withTransaction, requireRoles, rateLimit, HttpError, sendError }) {
    let tableReady;
    // Files live in MySQL so Railway redeployments cannot erase them.
    // No foreign keys are added here: existing installations use different ID column types.
    function ensureTable() {
        if (!tableReady) {
            tableReady = dbp.query(CREATE_TABLE).catch(error => {
                tableReady = null;
                throw error;
            });
        }
        return tableReady;
    }

    const readAccess = requireRoles('dispatcher', 'customer', 'manager', 'supervisor');
    const uploadAccess = requireRoles('dispatcher');
    const uploadLimit = rateLimit({ windowMs: 60 * 60_000, max: 30, message: 'Too many waybill uploads. Try again later.' });
    const rawFile = express.raw({ type: 'application/octet-stream', limit: MAX_BYTES });

    function validIds(req, res, next) {
        const ids = [req.params.id, ...(req.params.waybillId ? [req.params.waybillId] : [])];
        if (ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
            return res.status(400).json({ error: 'A valid booking and waybill ID is required.' });
        }
        res.setHeader('Cache-Control', 'no-store');
        next();
    }

    async function requireBooking(req, connection = dbp, lock = false) {
        const [rows] = await connection.query(
            `SELECT id, customer_id FROM service_requests WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
            [req.params.id]
        );
        if (!rows.length || (req.auth.role === 'customer' && String(rows[0].customer_id) !== String(req.auth.sub))) {
            throw new HttpError(404, 'Booking not found.');
        }
    }

    const base = '/api/service-requests/:id/waybills';
    app.get(base, readAccess, validIds, async (req, res) => {
        try {
            await requireBooking(req);
            await ensureTable();
            const [rows] = await dbp.query(
                'SELECT id, filename, content_type, byte_size, created_at FROM service_request_waybills WHERE service_request_id = ? ORDER BY id DESC',
                [req.params.id]
            );
            res.json(rows);
        } catch (error) {
            sendError(res, error, 'Unable to load waybills.');
        }
    });

    app.post(base, uploadAccess, validIds, uploadLimit, (req, res, next) => {
        rawFile(req, res, error => {
            if (!error) return next();
            res.status(error.type === 'entity.too.large' ? 413 : 400).json({
                error: error.type === 'entity.too.large' ? 'Each waybill must be 5 MB or smaller.' : 'Unable to read the uploaded file.'
            });
        });
    }, async (req, res) => {
        try {
            if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
                throw new HttpError(400, 'Choose a PDF, JPG, or PNG waybill.');
            }
            let filename;
            try { filename = decodeURIComponent(req.get('X-File-Name') || ''); }
            catch { throw new HttpError(400, 'The filename is invalid.'); }
            filename = filename.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 180);
            const detected = identifyFile(req.body);
            const extension = filename.split('.').pop().toLowerCase();
            if (!filename || !detected || !detected.extensions.includes(extension)) {
                throw new HttpError(400, 'Upload a PDF, JPG, or PNG file with a matching filename.');
            }
            await requireBooking(req);
            await ensureTable();
            const file = await withTransaction(async connection => {
                // Lock the parent booking to keep simultaneous uploads within the file limit.
                await requireBooking(req, connection, true);
                const [counts] = await connection.query(
                    'SELECT COUNT(*) AS total FROM service_request_waybills WHERE service_request_id = ?', [req.params.id]
                );
                if (Number(counts[0].total) >= MAX_FILES) throw new HttpError(409, 'This booking already has 10 waybills.');
                const [result] = await connection.query(
                    'INSERT INTO service_request_waybills (service_request_id, uploaded_by, filename, content_type, byte_size, content) VALUES (?, ?, ?, ?, ?, ?)',
                    [req.params.id, req.auth.sub, filename, detected.type, req.body.length, req.body]
                );
                return { id: result.insertId, filename, content_type: detected.type, byte_size: req.body.length };
            });
            res.status(201).json(file);
        } catch (error) {
            sendError(res, error, 'Unable to save the waybill.');
        }
    });

    app.get(`${base}/:waybillId`, readAccess, validIds, async (req, res) => {
        try {
            await requireBooking(req);
            await ensureTable();
            const [rows] = await dbp.query(
                'SELECT filename, content_type, byte_size, content FROM service_request_waybills WHERE id = ? AND service_request_id = ?',
                [req.params.waybillId, req.params.id]
            );
            if (!rows.length) throw new HttpError(404, 'Waybill not found.');
            const file = rows[0];
            const disposition = req.query.download === '1' ? 'attachment' : 'inline';
            const fallback = file.filename.replace(/[^a-zA-Z0-9._ -]/g, '_');
            const encodedName = encodeURIComponent(file.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
            res.setHeader('Content-Type', file.content_type);
            res.setHeader('Content-Disposition', `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodedName}`);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.send(file.content);
        } catch (error) {
            sendError(res, error, 'Unable to open the waybill.');
        }
    });
};

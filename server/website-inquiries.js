// Website messages remain in their original table so earlier inquiries are retained.
module.exports = function registerWebsiteInquiries(app, { dbp, requireRoles, auditUserAction, HttpError, sendError }) {
    let ready;
    function ensure() {
        if (!ready) ready = (async () => {
            const [columns] = await dbp.query('SHOW COLUMNS FROM customer_account_requests');
            const existing = new Set(columns.map(column => column.Field));
            for (const [name, definition] of Object.entries({
                followup_notes: 'TEXT NULL', contacted_at: 'DATETIME NULL',
                updated_by: 'BIGINT UNSIGNED NULL', updated_at: 'DATETIME NULL'
            })) if (!existing.has(name)) {
                try { await dbp.query(`ALTER TABLE customer_account_requests ADD COLUMN ${name} ${definition}`); }
                catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
            }
        })().catch(error => { ready = undefined; throw error; });
        return ready;
    }
    const staff = requireRoles('dispatcher', 'manager');
    app.get('/api/website-inquiries', staff, auditUserAction('website_inquiry.viewed', 'website_inquiry', 'Viewed website guest inquiries.', true), async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            await ensure();
            const [rows] = await dbp.query(`SELECT id,name,email,company,phone,message,status,created_at,
                followup_notes,contacted_at,updated_at FROM customer_account_requests ORDER BY created_at DESC,id DESC`);
            res.json(rows);
        } catch (error) { sendError(res, error, 'Unable to load website inquiries.'); }
    });
    app.put('/api/website-inquiries/:id', staff, auditUserAction('website_inquiry.updated', 'website_inquiry', 'Updated guest inquiry follow-up.'), async (req, res) => {
        const id = Number(req.params.id), { status, notes } = req.body || {};
        if (!Number.isSafeInteger(id) || id <= 0 || !['pending', 'contacted', 'processed', 'declined'].includes(status) ||
            typeof notes !== 'string' || notes.length > 2000) return res.status(400).json({ error: 'Choose a valid status and follow-up notes of 2,000 characters or fewer.' });
        try {
            await ensure();
            const [saved] = await dbp.query(`UPDATE customer_account_requests SET status=?,followup_notes=?,
                contacted_at=CASE WHEN ?='contacted' THEN COALESCE(contacted_at,NOW()) ELSE contacted_at END,
                updated_by=?,updated_at=NOW() WHERE id=?`, [status, notes.trim(), status, req.auth.sub, id]);
            if (!saved.affectedRows) throw new HttpError(404, 'Website inquiry not found.');
            res.json({ message: 'Inquiry follow-up saved.' });
        } catch (error) { sendError(res, error, 'Unable to save inquiry follow-up.'); }
    });
};

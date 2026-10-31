// Manager-only partner storage. Older installations predate the contact columns.
module.exports = function registerPartners(app, {
    dbp, requireManager, auditManagerAction, cleanText, isValidEmail, HttpError, sendError
}) {
    let contactColumnsReady;

    function ensureContactColumns() {
        if (!contactColumnsReady) {
            contactColumnsReady = (async () => {
                const [columns] = await dbp.query("SHOW COLUMNS FROM partners WHERE Field IN ('email', 'phone')");
                const existing = new Set(columns.map(column => column.Field));
                for (const [name, definition] of [['email', 'VARCHAR(255) NULL'], ['phone', 'VARCHAR(64) NULL']]) {
                    if (existing.has(name)) continue;
                    try {
                        // Column names and definitions are constants, never user input.
                        await dbp.query(`ALTER TABLE partners ADD COLUMN ${name} ${definition}`);
                    } catch (error) {
                        // Another service instance may have added it after SHOW COLUMNS.
                        if (error.code !== 'ER_DUP_FIELDNAME') throw error;
                    }
                }
            })().catch(error => {
                contactColumnsReady = null;
                console.error('Partner contact column update failed:', error);
                throw new HttpError(503, 'Partner storage could not be updated. Ask your administrator to check the partner contact columns.');
            });
        }
        return contactColumnsReady;
    }

    app.get('/api/partners', requireManager, async (req, res) => {
        try {
            const [partners] = await dbp.query('SELECT * FROM partners ORDER BY created_at DESC, id DESC');
            res.json(partners);
        } catch (error) {
            sendError(res, error, 'Unable to load partners.');
        }
    });

    app.post('/api/partners', requireManager,
        auditManagerAction('partner.created', 'partner', 'Manager added a business partner.'),
        async (req, res) => {
            const body = req.body || {};
            const company = cleanText(body.company, 255);
            const email = cleanText(body.email, 255);
            if (!company) return res.status(400).json({ error: 'Company name is required.' });
            if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid partner email address.' });
            try {
                await ensureContactColumns();
                const [result] = await dbp.query(
                    `INSERT INTO partners (company, contact_person, email, phone, partnership_type, contract_duration, agreement_details)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [company, cleanText(body.contact_person, 255) || null, email || null,
                        cleanText(body.phone, 64) || null, cleanText(body.partnership_type, 100) || null,
                        cleanText(body.contract_duration, 100) || null, cleanText(body.agreement_details, 2000) || null]
                );
                res.locals.auditEntityId = result.insertId;
                // Return only confirmed database values, including optional contact details.
                const [partners] = await dbp.query('SELECT * FROM partners WHERE id = ?', [result.insertId]);
                res.status(201).json({ ...partners[0], id: result.insertId, message: 'Partner saved' });
            } catch (error) {
                sendError(res, error, 'Unable to save partner.');
            }
        });

    app.delete('/api/partners/:id', requireManager,
        auditManagerAction('partner.deleted', 'partner', 'Manager removed a business partner.'),
        async (req, res) => {
            const partnerId = Number(req.params.id);
            if (!Number.isInteger(partnerId) || partnerId <= 0) {
                return res.status(400).json({ error: 'Invalid partner ID.' });
            }
            try {
                const [result] = await dbp.query('DELETE FROM partners WHERE id = ?', [partnerId]);
                if (result.affectedRows === 0) return res.status(404).json({ error: 'Partner not found.' });
                res.json({ message: 'Partner removed.' });
            } catch (error) {
                sendError(res, error, 'Unable to remove partner.');
            }
        });
};

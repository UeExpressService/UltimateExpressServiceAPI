module.exports = function registerAccountManagement(app, { dbp, withTransaction, requireManager, auditUserAction, isValidEmail, HttpError, sendError, ensureSessionVersion }) {
    const roles = ['customer', 'dispatcher', 'supervisor', 'manager'];
    // Lock the manager rows first so simultaneous changes cannot remove every manager.
    async function lockManagers(connection, actorId) {
        const [managers] = await connection.query("SELECT id FROM users WHERE role='manager' ORDER BY id FOR UPDATE");
        if (!managers.some(user => String(user.id) === String(actorId))) throw new HttpError(403, 'Your manager access has changed. Sign in again.');
        return managers;
    }
    app.put('/api/users/:id', requireManager, auditUserAction('account.updated', 'user', 'Updated an account profile or role.'), async (req, res) => {
        const userId = Number(req.params.id), body = req.body || {};
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 255) : '';
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user ID.' });
        if (!name || !isValidEmail(email)) return res.status(400).json({ error: 'Enter a name and valid email address.' });
        if (body.role !== undefined && !roles.includes(body.role)) return res.status(400).json({ error: 'Choose a valid account role.' });
        try {
            await ensureSessionVersion();
            const saved = await withTransaction(async connection => {
                const managers = await lockManagers(connection, req.auth.sub);
                const [[previous]] = await connection.query('SELECT id,role FROM users WHERE id=? FOR UPDATE', [userId]);
                if (!previous) throw new HttpError(404, 'Account not found.');
                const role = body.role ?? previous.role;
                if (String(userId) === String(req.auth.sub) && role !== previous.role) throw new HttpError(409, 'Another manager must change your role. You cannot remove your own manager access.');
                if (previous.role === 'manager' && role !== 'manager' && managers.length <= 1) throw new HttpError(409, 'The last manager must keep manager access.');
                await connection.query('UPDATE users SET name=?,email=?,company=?,phone=?,role=?,session_version=session_version+? WHERE id=?',
                    [name, email, String(body.company || '').trim().slice(0,255) || null, String(body.phone || '').trim().slice(0,64) || null, role, role !== previous.role ? 1 : 0, userId]);
                return { role, roleChanged: role !== previous.role, previousRole: previous.role };
            });
            res.locals.auditEntityId = userId;
            if (saved.roleChanged) res.locals.auditSummary = `Changed account role from ${saved.previousRole} to ${saved.role}. Existing sessions must sign in again.`;
            res.json({ message: saved.roleChanged ? 'Account and role updated. The user must sign in again.' : 'Account updated.', role: saved.role, roleChanged: saved.roleChanged });
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An account with that email already exists.' });
            sendError(res, error, 'Unable to update account.');
        }
    });
    app.delete('/api/users/:id', requireManager, auditUserAction('account.deleted', 'user', 'Deleted an account.'), async (req, res) => {
        const userId = Number(req.params.id);
        if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user ID.' });
        if (String(userId) === String(req.auth.sub)) return res.status(409).json({ error: 'You cannot delete your own account.' });
        try {
            await withTransaction(async connection => {
                const managers = await lockManagers(connection, req.auth.sub);
                const [[target]] = await connection.query('SELECT role FROM users WHERE id=? FOR UPDATE', [userId]);
                if (!target) throw new HttpError(404, 'Account not found.');
                if (target.role === 'manager' && managers.length <= 1) throw new HttpError(409, 'The last manager account cannot be deleted.');
                await connection.query('DELETE FROM users WHERE id=?', [userId]);
            });
            res.json({ message: 'Account deleted.' });
        } catch (error) {
            if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) return res.status(409).json({ error: 'This account has linked records and cannot be deleted.' });
            sendError(res, error, 'Unable to delete account.');
        }
    });
};

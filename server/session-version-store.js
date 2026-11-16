module.exports = function sessionVersionStore(dbp) {
    let ready;
    return function ensureSessionVersion() {
        if (!ready) ready = (async () => {
            const [columns] = await dbp.query("SHOW COLUMNS FROM users LIKE 'session_version'");
            if (columns.length) return;
            try { await dbp.query('ALTER TABLE users ADD COLUMN session_version INT UNSIGNED NOT NULL DEFAULT 0'); }
            catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
        })().catch(error => { ready = null; throw error; });
        return ready;
    };
};

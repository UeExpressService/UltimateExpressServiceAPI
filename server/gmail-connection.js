const crypto = require('crypto');

// Keep provider errors useful without logging tokens or request bodies.
function mailErrorSummary(error) {
    const allowed = new Set(['invalid_grant', 'invalid_client', 'access_denied', 'insufficient_scope', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);
    const code = error?.response?.data?.error;
    return { code: allowed.has(code) ? code : allowed.has(error?.code) ? error.code : 'email_provider_error', status: Number(error?.response?.status) || undefined };
}

function createGmailConnection({ dbp, google, env = process.env }) {
    const scope = 'https://www.googleapis.com/auth/gmail.send';
    const sender = String(env.GMAIL_USER || '').trim().toLowerCase();
    let origin, key;
    try {
        const base = new URL(env.PUBLIC_BASE_URL);
        if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Invalid public origin');
        origin = base.origin;
        key = Buffer.from(env.GMAIL_TOKEN_ENCRYPTION_KEY || '', 'base64');
        if (key.length !== 32) throw new Error('Missing encryption key');
    } catch { key = undefined; }
    const configured = Boolean(origin && key && sender && env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET);
    const cookieName = '__Host-ue_gmail_recovery';
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const aad = Buffer.from(`${sender}\n${env.GMAIL_CLIENT_ID}`);
    const client = () => new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, `${origin}/api/admin/gmail/callback`);
    let initialization;
    function ready() {
        if (!initialization) initialization = (async () => {
            await dbp.query(`CREATE TABLE IF NOT EXISTS gmail_authorization (
                id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
                encrypted_refresh_token TEXT NOT NULL,
                sender_email VARCHAR(255) NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
            await dbp.query(`CREATE TABLE IF NOT EXISTS gmail_authorization_states (
                state_hash CHAR(64) NOT NULL PRIMARY KEY,
                browser_hash CHAR(64) NOT NULL,
                expires_at DATETIME NOT NULL,
                used_at DATETIME NULL,
                INDEX idx_gmail_state_expiry (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        })().catch(error => { initialization = undefined; throw error; });
        return initialization;
    }
    function encrypt(token) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad);
        const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
        return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    }
    function decrypt(value) {
        const [version, iv, tag, data, extra] = String(value).split('.');
        if (version !== 'v1' || !iv || !tag || !data || extra) throw new Error('Invalid saved Gmail authorization');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    }
    async function getRefreshToken() {
        if (!configured) return env.GMAIL_REFRESH_TOKEN;
        await ready();
        const [rows] = await dbp.query('SELECT encrypted_refresh_token, sender_email FROM gmail_authorization WHERE id = 1');
        if (!rows.length) return env.GMAIL_REFRESH_TOKEN;
        if (rows[0].sender_email !== sender) throw new Error('Saved Gmail sender does not match configuration');
        return decrypt(rows[0].encrypted_refresh_token);
    }
    function register(app, rateLimit) {
        const limit = rateLimit({ windowMs: 60 * 60_000, max: 10, message: 'Too many email reconnection attempts. Try again later.' });
        const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
        const noStore = res => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); };
        app.post('/api/admin/gmail/reconnect', limit, async (req, res) => {
            noStore(res);
            if (!configured) return res.status(503).json({ error: 'Email recovery is not configured. Contact the website administrator.' });
            if (req.get('origin') !== origin) return res.status(403).json({ error: 'Open email recovery on the main Ultimate Express website.' });
            try {
                await ready();
                const state = crypto.randomBytes(32).toString('hex');
                const browser = crypto.randomBytes(32).toString('hex');
                await dbp.query('DELETE FROM gmail_authorization_states WHERE expires_at < NOW()');
                await dbp.execute('INSERT INTO gmail_authorization_states (state_hash, browser_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))', [digest(state), digest(browser)]);
                res.cookie(cookieName, browser, { ...cookieOptions, maxAge: 10 * 60_000 });
                const authorizationUrl = client().generateAuthUrl({
                    access_type: 'offline', prompt: 'consent', scope: ['openid', 'email', scope],
                    state, nonce: state, login_hint: sender, include_granted_scopes: false
                });
                res.json({ authorizationUrl });
            } catch (error) {
                console.error('Gmail recovery could not start:', mailErrorSummary(error));
                res.status(503).json({ error: 'Email recovery is temporarily unavailable. Please try again.' });
            }
        });
        app.get('/api/admin/gmail/callback', async (req, res) => {
            noStore(res);
            const finish = result => { res.clearCookie(cookieName, cookieOptions); return res.redirect(303, '/email-recovery.html?result=' + result); };
            if (!configured) return finish('unavailable');
            const state = typeof req.query.state === 'string' ? req.query.state : '';
            const browser = String(req.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
            if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browser)) return finish('expired');
            try {
                await ready();
                const [used] = await dbp.execute('UPDATE gmail_authorization_states SET used_at = NOW() WHERE state_hash = ? AND browser_hash = ? AND used_at IS NULL AND expires_at > NOW()', [digest(state), digest(browser)]);
                if (used.affectedRows !== 1) return finish('expired');
                if (req.query.error || typeof req.query.code !== 'string' || req.query.code.length > 4096) return finish('cancelled');
                const oauth = client();
                const { tokens } = await oauth.getToken(req.query.code);
                if (!tokens.id_token) return finish('wrong-account');
                const identity = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: env.GMAIL_CLIENT_ID });
                const claims = identity.getPayload();
                if (!claims || claims.email_verified !== true || String(claims.email || '').toLowerCase() !== sender || claims.nonce !== state) return finish('wrong-account');
                if (!tokens.refresh_token || !(tokens.scope || '').split(' ').includes(scope)) return finish('permission');
                oauth.setCredentials({ refresh_token: tokens.refresh_token });
                await oauth.getAccessToken();
                await dbp.execute('INSERT INTO gmail_authorization (id, encrypted_refresh_token, sender_email) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE encrypted_refresh_token = VALUES(encrypted_refresh_token), sender_email = VALUES(sender_email), updated_at = CURRENT_TIMESTAMP', [encrypt(tokens.refresh_token), sender]);
                res.locals.auditExternalActor = { name: 'Company Gmail owner', email: sender, role: 'company_owner' };
                res.locals.auditDescriptor = { action: 'gmail.reconnected', type: 'email_service', summary: 'Reconnected the company Gmail sender after Google verification.' };
                console.log('Company Gmail authorization reconnected.');
                return finish('connected');
            } catch (error) {
                console.error('Gmail recovery failed:', mailErrorSummary(error));
                return finish('unavailable');
            }
        });
    }
    return { getRefreshToken, register };
}

module.exports = { createGmailConnection, mailErrorSummary };

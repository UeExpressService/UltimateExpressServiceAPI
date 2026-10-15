// server.js  (updated: connection pool, Railway-ready, security + bug fixes)
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const sgMail = require('@sendgrid/mail');
const { google } = require('googleapis');
const bcrypt = require('bcryptjs');

const app = express();
app.set('trust proxy', 1); // Railway / Codespaces sit behind a proxy
const port = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET || '';
const emailFrom = process.env.GMAIL_USER || process.env.EMAIL_FROM || process.env.SENDGRID_FROM_EMAIL;
const gmailConfigured = Boolean(
    process.env.GMAIL_USER &&
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
);

if (gmailConfigured) {
    console.log('Gmail API email provider is configured.');
} else if (process.env.RESEND_API_KEY) {
    console.log('Resend email provider is configured.');
} else if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
    console.warn('No email provider is configured. Email sending will be disabled.');
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------
class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[character]));
}

function cleanText(value, max) {
    return String(value ?? '').trim().slice(0, max);
}

function isValidEmail(value) {
    return typeof value === 'string' && value.length <= 254 &&
        /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
}

function isValidMoney(amount) {
    return Number.isFinite(amount) && amount > 0 && amount < 10000000000 &&
        Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-7;
}

function rateLimit({ windowMs, max, message }) {
    const hits = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
    }, windowMs).unref();
    return (req, res, next) => {
        const now = Date.now();
        const key = req.ip || 'unknown';
        let entry = hits.get(key);
        if (!entry || entry.reset <= now) {
            entry = { count: 0, reset: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;
        if (entry.count > max) return res.status(429).json({ error: message });
        next();
    };
}

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, message: 'Too many login attempts. Try again in 15 minutes.' });
const codeLimiter = rateLimit({ windowMs: 15 * 60_000, max: 40, message: 'Too many code attempts. Try again in 15 minutes.' });
const resetLimiter = rateLimit({ windowMs: 60 * 60_000, max: 15, message: 'Too many reset requests. Try again later.' });
const accountRequestLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, message: 'Too many requests. Try again later.' });

// ------------------------------------------------------------------
// Session tokens (HS256 JWT)
// ------------------------------------------------------------------
function createSessionToken(user) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        sub: String(user.id),
        role: user.role,
        mustChangePassword: Boolean(user.must_change_password),
        iss: 'ultimate-express',
        aud: 'ultimate-express-api',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60
    })).toString('base64url');
    const content = `${header}.${payload}`;
    const signature = crypto.createHmac('sha256', sessionSecret).update(content).digest('base64url');
    return `${content}.${signature}`;
}

function hasSessionSecret() {
    return sessionSecret.length >= 32 && sessionSecret !== 'generate-a-long-random-secret';
}

function verifySessionToken(token) {
    if (!hasSessionSecret() || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expected = crypto.createHmac('sha256', sessionSecret).update(`${header}.${payload}`).digest();
    const received = Buffer.from(signature, 'base64url');
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;

    try {
        const tokenHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        const allowedRoles = ['customer', 'dispatcher', 'supervisor', 'manager'];
        return tokenHeader.alg === 'HS256' &&
            tokenHeader.typ === 'JWT' &&
            allowedRoles.includes(claims.role) &&
            Number.isInteger(Number(claims.sub)) &&
            Number(claims.sub) > 0 &&
            claims.iss === 'ultimate-express' &&
            claims.aud === 'ultimate-express-api' &&
            Number.isInteger(Number(claims.exp)) &&
            Number(claims.exp) > Math.floor(Date.now() / 1000)
            ? claims
            : null;
    } catch {
        return null;
    }
}

function getPublicBaseUrl() {
    const configured = String(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).trim();
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('PUBLIC_BASE_URL must use HTTP or HTTPS.');
    }
    return url.toString().replace(/\/$/, '');
}

function getPublicPageUrl(pagePath) {
    return new URL(pagePath.replace(/^\/+/, ''), `${getPublicBaseUrl()}/`);
}

function isBcryptHash(value) {
    return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function verifyPassword(storedPassword, suppliedPassword) {
    if (isBcryptHash(storedPassword)) {
        return bcrypt.compare(suppliedPassword, storedPassword);
    }
    return storedPassword === suppliedPassword;
}

function hashPassword(password) {
    return bcrypt.hash(password, 12);
}

function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function requireRoles(...allowedRoles) {
    return (req, res, next) => {
        const authorization = req.get('authorization') || '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        const claims = verifySessionToken(token);
        if (!claims) {
            return res.status(401).json({ error: 'A valid authenticated session is required.' });
        }
        if (!allowedRoles.includes(claims.role)) {
            return res.status(403).json({ error: 'Your account role cannot access this resource.' });
        }
        if (claims.mustChangePassword === true && req.path !== '/api/account/first-login-password') {
            return res.status(403).json({ error: 'Set a new password before using the application.' });
        }
        req.auth = claims;
        next();
    };
}

function requireManager(req, res, next) {
    return requireRoles('manager')(req, res, next);
}

function hasEmailProvider() {
    return Boolean(emailFrom && (
        gmailConfigured ||
        process.env.RESEND_API_KEY ||
        process.env.SENDGRID_API_KEY
    ));
}

function hashLoginCode(challengeId, code) {
    return crypto.createHmac('sha256', sessionSecret)
        .update(`${challengeId}:${code}`)
        .digest('hex');
}

function maskEmail(email) {
    const [name, domain] = String(email).split('@');
    if (!domain) return '';
    return `${name.slice(0, 1)}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain}`;
}

async function sendEmail(message) {
    if (!emailFrom) {
        console.warn('Email not sent because no sender email is configured.');
        return Promise.resolve();
    }

    if (gmailConfigured) {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        // Strip line breaks so user-supplied values can never inject extra mail headers.
        const to = String(message.to).replace(/[\r\n]+/g, ' ').trim();
        const subject = String(message.subject).replace(/[\r\n]+/g, ' ').trim();
        const rawMessage = [
            `From: ${emailFrom}`,
            `To: ${to}`,
            `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8',
            '',
            message.html
        ].join('\r\n');
        const encodedMessage = Buffer.from(rawMessage)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        return gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: encodedMessage }
        });
    }

    if (process.env.RESEND_API_KEY) {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: emailFrom,
                to: message.to,
                subject: message.subject,
                html: message.html
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Resend API error (${response.status}): ${errorBody}`);
        }
        return response.json();
    }

    if (!process.env.SENDGRID_API_KEY) {
        console.warn('Email not sent because no email provider is configured.');
        return Promise.resolve();
    }

    return sgMail.send({
        from: emailFrom,
        ...message
    });
}

// ------------------------------------------------------------------
// Database (connection POOL - survives Railway idle disconnects)
// Works with DB_* variables OR Railway's MYSQL* variables.
// ------------------------------------------------------------------
const dbTimezone = process.env.DB_TIMEZONE || '+08:00'; // Philippine time
const db = mysql.createPool({
    host: process.env.DB_HOST || process.env.MYSQLHOST,
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
    user: process.env.DB_USER || process.env.MYSQLUSER,
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
    database: process.env.DB_NAME || process.env.MYSQLDATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    dateStrings: ['DATE'],   // DATE columns stay 'YYYY-MM-DD' (no off-by-one-day bug)
    timezone: dbTimezone
});
db.on('connection', connection => {
    connection.query('SET time_zone = ?', [dbTimezone]);
});
const dbp = db.promise();

dbp.query('SELECT 1')
    .then(() => console.log('Connected to MySQL database.'))
    .catch(error => console.error('Database connection failed:', error.message));

async function withTransaction(work) {
    const connection = await dbp.getConnection();
    try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try { await connection.rollback(); } catch { /* ignore */ }
        throw error;
    } finally {
        connection.release();
    }
}

function sendError(res, error, fallbackMessage) {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    console.error(fallbackMessage, error);
    return res.status(500).json({ error: fallbackMessage });
}

function auditManagerAction(action, entityType, summary) {
    return (req, res, next) => {
        res.once('finish', () => {
            if (req.auth?.role !== 'manager' || res.statusCode < 200 || res.statusCode >= 300) return;
            const entityId = req.params.id || req.body?.requestId || res.locals.auditEntityId || null;
            db.query(
                `INSERT INTO manager_audit_logs (actor_user_id, action, entity_type, entity_id, summary)
                 VALUES (?, ?, ?, ?, ?)`,
                [Number(req.auth.sub), action, entityType, entityId == null ? null : String(entityId), summary],
                error => {
                    if (error) console.error('Manager activity audit write failed:', error);
                }
            );
        });
        next();
    };
}

// ------------------------------------------------------------------
// Middleware
// ------------------------------------------------------------------
const allowedOrigins = new Set(
    (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5500,http://127.0.0.1:5500')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
);
// Same-site requests (page and API on the same host, e.g. Railway) are always allowed.
app.use(cors((req, callback) => {
    const origin = req.header('Origin');
    if (!origin) return callback(null, { origin: false });
    let sameHost = false;
    try { sameHost = new URL(origin).host === req.headers.host; } catch { sameHost = false; }
    callback(null, { origin: sameHost || allowedOrigins.has(origin) });
}));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(express.json({ limit: '200kb' }));

// ------------------------------------------------------------------
// Front-end files
// ------------------------------------------------------------------
function findFrontendDir() {
    const candidates = [
        process.env.FRONTEND_DIR,
        path.join(__dirname, '..', 'Latest Update'),
        path.join(__dirname, 'Latest Update'),
        path.join(__dirname, '..'),
        __dirname
    ].filter(Boolean);
    return candidates.find(dir => fs.existsSync(path.join(dir, 'LandingPage.html'))) || candidates[0];
}
const frontendPath = findFrontendDir();
console.log(`Serving front-end files from: ${frontendPath}`);

const publicScripts = new Set(['auth.js', 'api-config.js', 'route-map.js']);
const publicExtensions = /\.(html|css|js|png|jpe?g|webp|gif|svg|ico|woff2?)$/i;

app.get('/health', (req, res) => res.json({ ok: true }));
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(frontendPath, 'LandingPage.html')));

// Only web files may be served. Blocks .env, .sql, .json, server.js, scripts, etc.
app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.endsWith('/')) return next();
    const base = path.basename(req.path);
    if (!base.includes('.')) return res.status(404).end();
    if (!publicExtensions.test(base)) return res.status(404).end();
    if (/\.js$/i.test(base) && !publicScripts.has(base.toLowerCase())) return res.status(404).end();
    next();
});
app.use(express.static(frontendPath));

// ---------- API Routes ----------

app.post('/api/account/first-login-password', requireRoles('customer', 'dispatcher', 'supervisor', 'manager'), async (req, res) => {
    if (req.auth.mustChangePassword !== true) {
        return res.status(403).json({ error: 'This account does not require a first-login password change.' });
    }
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirmation = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';
    if (password.length < 12 || password.length > 128) {
        return res.status(400).json({ error: 'Use a password between 12 and 128 characters.' });
    }
    if (password !== confirmation) {
        return res.status(400).json({ error: 'The passwords do not match.' });
    }

    try {
        const hashedPassword = await hashPassword(password);
        const [updated] = await dbp.query(
            'UPDATE users SET password = ?, must_change_password = 0 WHERE id = ? AND must_change_password = 1',
            [hashedPassword, Number(req.auth.sub)]
        );
        if (updated.affectedRows === 0) {
            return res.status(409).json({ error: 'The password setup was already completed. Sign in again.' });
        }
        const [users] = await dbp.query(
            'SELECT id, name, email, role, company, phone, must_change_password FROM users WHERE id = ? LIMIT 1',
            [Number(req.auth.sub)]
        );
        if (users.length === 0) {
            return res.status(404).json({ error: 'Account not found.' });
        }
        res.json({
            authToken: createSessionToken(users[0]),
            message: 'Password set successfully.'
        });
    } catch (error) {
        sendError(res, error, 'Unable to set the new password.');
    }
});

// First factor: validate the account password and email a short-lived code.
app.post('/api/login', loginLimiter, async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || !password) {
        return res.status(400).json({ error: 'Enter your email and password.' });
    }
    if (!hasSessionSecret()) {
        return res.status(503).json({ error: 'Login verification is not configured. Set SESSION_SECRET in server/.env.' });
    }
    if (!hasEmailProvider()) {
        return res.status(503).json({ error: 'Email verification is unavailable. Configure an email provider in server/.env.' });
    }

    try {
        await dbp.query(
            'DELETE FROM login_code_challenges WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'
        );
        const [users] = await dbp.query(
            'SELECT id, name, email, role, company, phone, password FROM users WHERE email = ? LIMIT 1',
            [email.toLowerCase()]
        );
        if (users.length === 0 || !(await verifyPassword(users[0].password, password))) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = users[0];
        if (!isBcryptHash(user.password)) {
            const hashedPassword = await hashPassword(password);
            await dbp.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id]);
        }
        const [recentCodes] = await dbp.query(
            `SELECT COUNT(*) AS count, MAX(created_at) AS last_sent
             FROM login_code_challenges
             WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
            [user.id]
        );
        if (Number(recentCodes[0].count) >= 5) {
            return res.status(429).json({ error: 'Too many login codes requested. Try again in an hour.' });
        }
        if (recentCodes[0].last_sent &&
            Date.now() - new Date(recentCodes[0].last_sent).getTime() < 60_000) {
            return res.status(429).json({ error: 'A login code was just sent. Wait a minute before requesting another.' });
        }

        const challengeId = crypto.randomUUID();
        const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
        const codeHash = hashLoginCode(challengeId, code);
        const expiresAt = new Date(Date.now() + 10 * 60_000);
        try {
            await sendEmail({
                to: user.email,
                subject: 'Your Ultimate Express login code',
                html: `<p>Hello ${escapeHtml(user.name)},</p>
                    <p>Your Ultimate Express login verification code is:</p>
                    <p style="font-size:28px;font-weight:bold;letter-spacing:6px;">${code}</p>
                    <p>This code expires in 10 minutes and can only be used once. If you did not request it, you can ignore this message.</p>`
            });
        } catch (error) {
            console.error('Login verification email failed:', error);
            return res.status(503).json({ error: 'Could not send the login code. Check the email provider configuration and try again.' });
        }

        await dbp.query(
            `UPDATE login_code_challenges SET consumed_at = NOW()
             WHERE user_id = ? AND consumed_at IS NULL`,
            [user.id]
        );
        await dbp.query(
            `INSERT INTO login_code_challenges
                (challenge_id, user_id, code_hash, expires_at)
             VALUES (?, ?, ?, ?)`,
            [challengeId, user.id, codeHash, expiresAt]
        );
        res.json({
            requiresCode: true,
            challengeId,
            maskedEmail: maskEmail(user.email),
            expiresInSeconds: 600
        });
    } catch (error) {
        sendError(res, error, 'Unable to start login verification.');
    }
});

// Second factor: consume a valid login code and create the account session.
app.post('/api/login/verify-code', codeLimiter, async (req, res) => {
    const challengeId = typeof req.body.challengeId === 'string' ? req.body.challengeId : '';
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) {
        return res.status(400).json({ error: 'Enter the six-digit code from your email.' });
    }
    if (!hasSessionSecret()) {
        return res.status(503).json({ error: 'Login verification is not configured. Set SESSION_SECRET in server/.env.' });
    }

    try {
        const outcome = await withTransaction(async connection => {
            const [challenges] = await connection.query(
                `SELECT challenge_id, user_id, code_hash, attempts
                 FROM login_code_challenges
                 WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > NOW()
                 FOR UPDATE`,
                [challengeId]
            );
            if (challenges.length === 0 || Number(challenges[0].attempts) >= 5) {
                return { status: 400, body: { error: 'This code is invalid or expired. Request a new login code.' } };
            }

            const challenge = challenges[0];
            const expected = Buffer.from(challenge.code_hash, 'hex');
            const received = Buffer.from(hashLoginCode(challengeId, code), 'hex');
            if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
                await connection.query(
                    'UPDATE login_code_challenges SET attempts = attempts + 1 WHERE challenge_id = ?',
                    [challengeId]
                );
                return { status: 400, body: { error: 'The login code is incorrect or expired.' } };
            }

            await connection.query(
                'UPDATE login_code_challenges SET consumed_at = NOW() WHERE challenge_id = ?',
                [challengeId]
            );
            const [users] = await connection.query(
                'SELECT id, name, email, role, company, phone, must_change_password FROM users WHERE id = ? LIMIT 1',
                [challenge.user_id]
            );
            if (users.length === 0) {
                return { status: 401, body: { error: 'This account is no longer available.' } };
            }
            const user = users[0];
            return {
                status: 200,
                body: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    company: user.company,
                    phone: user.phone,
                    mustChangePassword: Boolean(user.must_change_password),
                    authToken: createSessionToken(user)
                }
            };
        });
        res.status(outcome.status).json(outcome.body);
    } catch (error) {
        sendError(res, error, 'Unable to verify the login code.');
    }
});

app.post('/api/customer/password-reset/request', resetLimiter, async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!hasSessionSecret()) {
        return res.status(503).json({ error: 'Password reset is not configured. Set SESSION_SECRET in server/.env.' });
    }
    if (!hasEmailProvider()) {
        return res.status(503).json({ error: 'Password reset email is unavailable. Configure an email provider in server/.env.' });
    }

    try {
        const [users] = await dbp.query(
            'SELECT id, name, email FROM users WHERE email = ? AND role = ? LIMIT 1',
            [email, 'customer']
        );
        if (users.length > 0) {
            const user = users[0];
            const [recentRequests] = await dbp.query(
                `SELECT COUNT(*) AS count FROM customer_password_resets
                 WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
                [user.id]
            );
            if (Number(recentRequests[0].count) < 3) {
                const token = crypto.randomBytes(32).toString('base64url');
                const tokenHash = hashResetToken(token);
                const expiresAt = new Date(Date.now() + 30 * 60_000);
                await dbp.query(
                    `UPDATE customer_password_resets SET consumed_at = NOW()
                     WHERE user_id = ? AND consumed_at IS NULL`,
                    [user.id]
                );
                await dbp.query(
                    `INSERT INTO customer_password_resets
                        (user_id, token_hash, expires_at)
                     VALUES (?, ?, ?)`,
                    [user.id, tokenHash, expiresAt]
                );
                try {
                    const resetLink = getPublicPageUrl(`reset-password.html?token=${encodeURIComponent(token)}`);
                    await sendEmail({
                        to: user.email,
                        subject: 'Confirm your Ultimate Express password reset',
                        html: `<p>Hello ${escapeHtml(user.name)},</p>
                            <p>We received a request to change your customer-account password. To confirm and continue, open the link below. It expires in 30 minutes and can only be used once.</p>
                            <p><a href="${escapeHtml(resetLink.toString())}">Confirm password reset</a></p>
                            <p>If you did not request this, ignore this email. Your password will not change.</p>`
                    });
                } catch (emailError) {
                    console.error('Customer password reset email failed:', emailError);
                }
            }
        }
        res.json({ message: 'If that email belongs to a customer account, password-reset instructions will be sent.' });
    } catch (error) {
        sendError(res, error, 'Unable to process the password reset request.');
    }
});

app.post('/api/customer/password-reset/confirm', resetLimiter, async (req, res) => {
    const token = typeof req.body.token === 'string' ? req.body.token : '';
    const newPassword = typeof req.body.password === 'string' ? req.body.password : '';
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
        return res.status(400).json({ error: 'This reset link is invalid or expired. Request a new one.' });
    }
    if (newPassword.length < 12 || newPassword.length > 128) {
        return res.status(400).json({ error: 'Use a password between 12 and 128 characters.' });
    }
    if (!hasSessionSecret()) {
        return res.status(503).json({ error: 'Password reset is not configured. Set SESSION_SECRET in server/.env.' });
    }

    try {
        const hashedPassword = await hashPassword(newPassword);
        const outcome = await withTransaction(async connection => {
            const [resets] = await connection.query(
                `SELECT reset.id, reset.user_id
                 FROM customer_password_resets reset
                 JOIN users u ON u.id = reset.user_id AND u.role = 'customer'
                 WHERE reset.token_hash = ? AND reset.consumed_at IS NULL AND reset.expires_at > NOW()
                 LIMIT 1 FOR UPDATE`,
                [hashResetToken(token)]
            );
            if (resets.length === 0) {
                return { status: 400, body: { error: 'This reset link is invalid or expired. Request a new one.' } };
            }
            await connection.query(
                'UPDATE users SET password = ?, must_change_password = 0 WHERE id = ? AND role = ?',
                [hashedPassword, resets[0].user_id, 'customer']
            );
            await connection.query(
                'UPDATE customer_password_resets SET consumed_at = NOW() WHERE user_id = ? AND consumed_at IS NULL',
                [resets[0].user_id]
            );
            await connection.query(
                'UPDATE login_code_challenges SET consumed_at = NOW() WHERE user_id = ? AND consumed_at IS NULL',
                [resets[0].user_id]
            );
            return { status: 200, body: { message: 'Password changed. You can now sign in with your new password.' } };
        });
        res.status(outcome.status).json(outcome.body);
    } catch (error) {
        sendError(res, error, 'Unable to change the password.');
    }
});

app.get('/api/manager/audit-logs', requireManager, (req, res) => {
    const requestedLimit = Number(req.query.limit) || 100;
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 200);
    db.query(
        `SELECT log.id, log.actor_user_id, account.name AS actor_name, account.email AS actor_email,
                log.action, log.entity_type, log.entity_id, log.summary, log.created_at
         FROM manager_audit_logs log
         LEFT JOIN users account ON account.id = log.actor_user_id
         ORDER BY log.created_at DESC
         LIMIT ?`,
        [limit],
        (error, rows) => {
            if (error) {
                console.error('Manager audit log load failed:', error);
                return res.status(500).json({ error: 'Unable to load manager activity.' });
            }
            res.json(rows);
        }
    );
});

// ---------- Trucks ----------
// Everyone in operations can READ the fleet; only manager/supervisor can change it.
const FLEET_STATUSES = ['available', 'busy', 'maintenance'];

app.get('/api/trucks', requireRoles('manager', 'supervisor', 'dispatcher'), (req, res) => {
    db.query('SELECT * FROM trucks', (err, results) => {
        if (err) return sendError(res, err, 'Unable to load trucks.');
        res.json(results);
    });
});

app.post('/api/trucks', requireRoles('manager', 'supervisor'), (req, res) => {
    const type = cleanText(req.body.type, 255);
    const licensePlate = cleanText(req.body.license_plate, 100);
    const status = FLEET_STATUSES.includes(req.body.status) ? req.body.status : 'available';
    const dailyRate = Number(req.body.daily_rate) >= 0 ? Number(req.body.daily_rate) : 0;
    if (!type || !licensePlate) {
        return res.status(400).json({ error: 'Truck type and plate number are required.' });
    }
    const thirdParty = Boolean(req.body.third_party);
    const sql = `INSERT INTO trucks
        (type, license_plate, daily_rate, status, third_party, capacity, location, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    db.query(sql, [
        type, licensePlate, dailyRate, status, thirdParty,
        cleanText(req.body.capacity, 64) || null,
        cleanText(req.body.location, 255) || null,
        cleanText(req.body.notes, 2000) || null
    ], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A truck with that plate number already exists.' });
            return sendError(res, err, 'Unable to save truck.');
        }
        res.json({ id: result.insertId, type, license_plate: licensePlate, status, third_party: thirdParty });
    });
});

app.put('/api/trucks/:id', requireRoles('manager', 'supervisor'), (req, res) => {
    const type = cleanText(req.body.type, 255);
    const licensePlate = cleanText(req.body.license_plate, 100);
    const status = FLEET_STATUSES.includes(req.body.status) ? req.body.status : null;
    if (!type || !licensePlate || !status) {
        return res.status(400).json({ error: 'Truck type, plate number, and a valid status are required.' });
    }
    const dailyRate = Number(req.body.daily_rate) >= 0 ? Number(req.body.daily_rate) : 0;
    const { third_party, capacity, location, notes } = req.body;
    const sql = `UPDATE trucks SET type=?, license_plate=?, daily_rate=?, status=?,
        third_party=COALESCE(?, third_party), capacity=COALESCE(?, capacity),
        location=COALESCE(?, location), notes=COALESCE(?, notes) WHERE id=?`;
    db.query(sql, [
        type, licensePlate, dailyRate, status,
        third_party === undefined ? null : Boolean(third_party),
        capacity == null ? null : cleanText(capacity, 64),
        location == null ? null : cleanText(location, 255),
        notes == null ? null : cleanText(notes, 2000),
        req.params.id
    ], (err) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A truck with that plate number already exists.' });
            return sendError(res, err, 'Unable to update truck.');
        }
        res.json({ message: 'Truck updated' });
    });
});

app.delete('/api/trucks/:id', requireRoles('manager', 'supervisor'), async (req, res) => {
    try {
        const [active] = await dbp.query(
            `SELECT COUNT(*) AS total FROM service_requests
             WHERE assigned_truck_id = ? AND status IN ('approved', 'ongoing')`,
            [req.params.id]
        );
        if (Number(active[0].total) > 0) {
            return res.status(409).json({ error: 'This truck is assigned to an active delivery and cannot be deleted.' });
        }
        await dbp.query('DELETE FROM trucks WHERE id=?', [req.params.id]);
        res.json({ message: 'Truck deleted' });
    } catch (error) {
        sendError(res, error, 'Unable to delete truck.');
    }
});

// ---------- Drivers ----------
app.get('/api/drivers', requireRoles('manager', 'supervisor', 'dispatcher'), (req, res) => {
    db.query('SELECT * FROM drivers', (err, results) => {
        if (err) return sendError(res, err, 'Unable to load drivers.');
        res.json(results);
    });
});

app.post('/api/drivers', requireRoles('manager', 'supervisor'), (req, res) => {
    const name = cleanText(req.body.name, 255);
    const licenseNumber = cleanText(req.body.license_number, 100);
    const status = FLEET_STATUSES.includes(req.body.status) ? req.body.status : 'available';
    if (!name || !licenseNumber) {
        return res.status(400).json({ error: 'Driver name and license number are required.' });
    }
    const sql = `INSERT INTO drivers (name, license_number, phone, status, email, experience, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.query(sql, [
        name, licenseNumber,
        cleanText(req.body.phone, 64) || null,
        status,
        cleanText(req.body.email, 255) || null,
        cleanText(req.body.experience, 100) || null,
        cleanText(req.body.notes, 2000) || null
    ], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A driver with that license number already exists.' });
            return sendError(res, err, 'Unable to save driver.');
        }
        res.json({ id: result.insertId, name, license_number: licenseNumber, status });
    });
});

app.put('/api/drivers/:id', requireRoles('manager', 'supervisor'), (req, res) => {
    const name = cleanText(req.body.name, 255);
    const licenseNumber = cleanText(req.body.license_number, 100);
    const status = FLEET_STATUSES.includes(req.body.status) ? req.body.status : null;
    if (!name || !licenseNumber || !status) {
        return res.status(400).json({ error: 'Driver name, license number, and a valid status are required.' });
    }
    const { phone, email, experience, notes } = req.body;
    const sql = `UPDATE drivers SET name=?, license_number=?, phone=?, status=?,
        email=COALESCE(?, email), experience=COALESCE(?, experience),
        notes=COALESCE(?, notes) WHERE id=?`;
    db.query(sql, [
        name, licenseNumber, cleanText(phone, 64) || null, status,
        email == null ? null : cleanText(email, 255),
        experience == null ? null : cleanText(experience, 100),
        notes == null ? null : cleanText(notes, 2000),
        req.params.id
    ], (err) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A driver with that license number already exists.' });
            return sendError(res, err, 'Unable to update driver.');
        }
        res.json({ message: 'Driver updated' });
    });
});

app.delete('/api/drivers/:id', requireRoles('manager', 'supervisor'), async (req, res) => {
    try {
        const [active] = await dbp.query(
            `SELECT COUNT(*) AS total FROM service_requests
             WHERE assigned_driver_id = ? AND status IN ('approved', 'ongoing')`,
            [req.params.id]
        );
        if (Number(active[0].total) > 0) {
            return res.status(409).json({ error: 'This driver is assigned to an active delivery and cannot be deleted.' });
        }
        await dbp.query('DELETE FROM drivers WHERE id=?', [req.params.id]);
        res.json({ message: 'Driver deleted' });
    } catch (error) {
        sendError(res, error, 'Unable to delete driver.');
    }
});

// ---------- Service Requests ----------
app.get('/api/service-requests', requireRoles('manager', 'supervisor', 'dispatcher', 'customer'), (req, res) => {
    const customerOnly = req.auth.role === 'customer';
    const sql = `
        SELECT sr.*, u.name AS customer_name, u.company AS customer_company
        FROM service_requests sr
        LEFT JOIN users u ON sr.customer_id = u.id
        ${customerOnly ? 'WHERE sr.customer_id = ?' : ''}
        ORDER BY sr.created_at DESC
    `;
    db.query(sql, customerOnly ? [Number(req.auth.sub)] : [], (err, results) => {
        if (err) return sendError(res, err, 'Unable to load service requests.');
        res.json(results);
    });
});

app.put('/api/service-requests/:id/payment', requireManager, auditManagerAction('payment.recorded', 'service_request', 'Manager recorded or changed a final payment amount.'), async (req, res) => {
    const requestId = Number(req.params.id);
    const paidAmount = Number(req.body.paid_amount);
    if (!Number.isInteger(requestId) || requestId < 1) {
        return res.status(400).json({ error: 'A valid service request ID is required.' });
    }
    if (!isValidMoney(paidAmount)) {
        return res.status(400).json({ error: 'Enter a payment amount greater than zero with no more than two decimal places.' });
    }

    try {
        const [existing] = await dbp.query('SELECT id FROM service_requests WHERE id = ?', [requestId]);
        if (existing.length === 0) {
            return res.status(404).json({ error: 'Service request not found.' });
        }
        await dbp.query(
            'UPDATE service_requests SET paid_amount = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?',
            [paidAmount, requestId]
        );
        const [updated] = await dbp.query(
            'SELECT id, paid_amount, paid_at FROM service_requests WHERE id = ?',
            [requestId]
        );
        res.json(updated[0]);
    } catch (error) {
        sendError(res, error, 'Unable to record payment.');
    }
});

app.post('/api/service-requests', requireRoles('customer', 'dispatcher'), (req, res) => {
    const body = req.body || {};
    if (req.auth.role === 'customer' && Number(body.customer_id) !== Number(req.auth.sub)) {
        return res.status(403).json({ error: 'Customers may only submit service requests for their own account.' });
    }
    if (req.auth.role === 'customer' && body.terms_accepted !== true) {
        return res.status(400).json({ error: 'You must accept the service terms before submitting a request.' });
    }
    const quotedAmount = req.auth.role === 'dispatcher' && body.quoted_amount != null
        ? Number(body.quoted_amount)
        : null;
    if (quotedAmount !== null && !isValidMoney(quotedAmount)) {
        return res.status(400).json({ error: 'Enter a quote greater than zero with no more than two decimal places.' });
    }

    const customerId = req.auth.role === 'customer'
        ? Number(req.auth.sub)
        : (body.customer_id ? Number(body.customer_id) : null);
    const contactPerson = cleanText(body.contact_person, 255);
    const contactEmail = cleanText(body.contact_email, 255).toLowerCase();
    const contactPhone = cleanText(body.contact_phone, 64);
    const pickupLocation = cleanText(body.pickup_location, 500);
    const deliveryLocation = cleanText(body.delivery_location, 500);
    const cargoType = cleanText(body.cargo_type, 100);
    const cargoWeight = cleanText(body.cargo_weight, 100);
    const specialRequirements = cleanText(body.special_requirements, 2000);
    const pickupDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.pickup_date || '')) ? body.pickup_date : null;
    const preferredTime = cleanText(body.preferred_time, 100);
    const truckType = cleanText(body.truck_type, 255);

    if (!contactPerson || !isValidEmail(contactEmail) || !pickupLocation || !deliveryLocation) {
        return res.status(400).json({ error: 'Enter a contact name, a valid email address, and pickup and delivery addresses.' });
    }

    const sql = `
        INSERT INTO service_requests
        (customer_id, cargo_type, cargo_weight, special_requirements,
         pickup_location, delivery_location, pickup_date, preferred_time,
         truck_type, contact_person, contact_phone, contact_email, quoted_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    db.query(sql, [
        customerId, cargoType, cargoWeight, specialRequirements,
        pickupLocation, deliveryLocation, pickupDate, preferredTime,
        truckType, contactPerson, contactPhone, contactEmail, quotedAmount
    ], (err, result) => {
        if (err) return sendError(res, err, 'Unable to submit the request.');

        // Answer the user right away; emails are sent in the background.
        res.status(201).json({ id: result.insertId, message: 'Request submitted' });

        const customerBody = `
            <p>Hi ${escapeHtml(contactPerson)},</p>
            <p>Thank you for requesting a service quotation from Ultimate Express.</p>
            <p>We received your request and will contact you soon.</p>
            <h3>Request details</h3>
            <ul>
                <li><strong>Name:</strong> ${escapeHtml(contactPerson)}</li>
                <li><strong>Email:</strong> ${escapeHtml(contactEmail)}</li>
                <li><strong>Phone:</strong> ${escapeHtml(contactPhone)}</li>
                <li><strong>Pickup:</strong> ${escapeHtml(pickupLocation)}</li>
                <li><strong>Delivery:</strong> ${escapeHtml(deliveryLocation)}</li>
                <li><strong>Cargo details:</strong> ${escapeHtml(specialRequirements)}</li>
            </ul>
            <p>If you have questions, reply to this email or contact our support team.</p>
            <p>Best regards,<br/>Ultimate Express</p>
        `;
        const emails = [sendEmail({
            to: contactEmail,
            subject: 'Ultimate Express Quote Request Received',
            html: customerBody
        })];

        if (process.env.ADMIN_EMAIL) {
            const adminBody = `
                <p>A new service request has been submitted.</p>
                <h3>Customer details</h3>
                <ul>
                    <li><strong>Name:</strong> ${escapeHtml(contactPerson)}</li>
                    <li><strong>Email:</strong> ${escapeHtml(contactEmail)}</li>
                    <li><strong>Phone:</strong> ${escapeHtml(contactPhone)}</li>
                </ul>
                <h3>Route</h3>
                <ul>
                    <li><strong>Pickup:</strong> ${escapeHtml(pickupLocation)}</li>
                    <li><strong>Delivery:</strong> ${escapeHtml(deliveryLocation)}</li>
                </ul>
                <h3>Cargo</h3>
                <p>${escapeHtml(specialRequirements)}</p>
            `;
            emails.push(sendEmail({
                to: process.env.ADMIN_EMAIL,
                subject: 'New Ultimate Express Service Request',
                html: adminBody
            }));
        }
        Promise.all(emails)
            .then(() => console.log('Email notifications sent for service request', result.insertId))
            .catch(emailError => console.error('Error sending email notifications:', emailError));
    });
});

app.put('/api/service-requests/:id', requireRoles('manager', 'dispatcher'), auditManagerAction('service_request.updated', 'service_request', 'Manager updated service request details, pricing, or assignments.'), async (req, res) => {
    const body = req.body || {};
    const allowedStatuses = ['new', 'pending', 'approved', 'ongoing', 'completed'];
    if (!allowedStatuses.includes(body.status)) {
        return res.status(400).json({ error: 'Invalid service request status' });
    }
    if (body.quoted_amount !== undefined && body.quoted_amount !== null &&
        !isValidMoney(Number(body.quoted_amount))) {
        return res.status(400).json({ error: 'Enter a quote greater than zero with no more than two decimal places.' });
    }

    try {
        await withTransaction(async connection => {
            const [requests] = await connection.query(
                'SELECT * FROM service_requests WHERE id = ? FOR UPDATE',
                [req.params.id]
            );
            if (requests.length === 0) throw new HttpError(404, 'Service request not found');
            const previous = requests[0];

            // Any field the browser did not send keeps its current value.
            const pick = (field, max) => body[field] === undefined
                ? previous[field]
                : (max ? cleanText(body[field], max) : body[field]);
            const pickupDateRaw = body.pickup_date === undefined ? previous.pickup_date : body.pickup_date;
            const pickupDate = typeof pickupDateRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(pickupDateRaw)
                ? pickupDateRaw.slice(0, 10)
                : null;

            const assignedDriverId = body.driver_id === undefined ? previous.assigned_driver_id : body.driver_id || null;
            const assignedTruckId = body.truck_id === undefined ? previous.assigned_truck_id : body.truck_id || null;
            const quotedAmount = body.quoted_amount === undefined ? previous.quoted_amount : body.quoted_amount;

            // Block double-booking: a newly chosen driver/truck must be available right now.
            if (assignedDriverId && String(assignedDriverId) !== String(previous.assigned_driver_id)) {
                const [drivers] = await connection.query('SELECT status FROM drivers WHERE id = ? FOR UPDATE', [assignedDriverId]);
                if (drivers.length === 0) throw new HttpError(400, 'The selected driver no longer exists.');
                if (drivers[0].status !== 'available') throw new HttpError(409, 'The selected driver is not available.');
            }
            if (assignedTruckId && String(assignedTruckId) !== String(previous.assigned_truck_id)) {
                const [trucks] = await connection.query('SELECT status FROM trucks WHERE id = ? FOR UPDATE', [assignedTruckId]);
                if (trucks.length === 0) throw new HttpError(400, 'The selected truck no longer exists.');
                if (trucks[0].status !== 'available') throw new HttpError(409, 'The selected truck is not available.');
            }

            await connection.query(
                `UPDATE service_requests
                 SET status = ?, cargo_type = ?, cargo_weight = ?, special_requirements = ?,
                     pickup_location = ?, delivery_location = ?, pickup_date = ?, preferred_time = ?,
                     truck_type = ?, contact_person = ?, contact_phone = ?, contact_email = ?,
                     assigned_driver_id = ?, assigned_truck_id = ?, quoted_amount = ?
                 WHERE id = ?`,
                [
                    body.status, pick('cargo_type', 100), pick('cargo_weight', 100), pick('special_requirements', 2000),
                    pick('pickup_location', 500), pick('delivery_location', 500), pickupDate, pick('preferred_time', 100),
                    pick('truck_type', 255), pick('contact_person', 255), pick('contact_phone', 64), pick('contact_email', 255),
                    assignedDriverId, assignedTruckId, quotedAmount, req.params.id
                ]
            );

            const resourceStatus = ['approved', 'ongoing'].includes(body.status) ? 'busy' : 'available';
            if (previous.assigned_driver_id && String(previous.assigned_driver_id) !== String(assignedDriverId)) {
                await connection.query('UPDATE drivers SET status = ? WHERE id = ?', ['available', previous.assigned_driver_id]);
            }
            if (previous.assigned_truck_id && String(previous.assigned_truck_id) !== String(assignedTruckId)) {
                await connection.query('UPDATE trucks SET status = ? WHERE id = ?', ['available', previous.assigned_truck_id]);
            }
            if (assignedDriverId) {
                await connection.query('UPDATE drivers SET status = ? WHERE id = ?', [resourceStatus, assignedDriverId]);
            }
            if (assignedTruckId) {
                await connection.query('UPDATE trucks SET status = ? WHERE id = ?', [resourceStatus, assignedTruckId]);
            }
        });
        res.json({ message: 'Request updated' });
    } catch (error) {
        sendError(res, error, 'Unable to update service request');
    }
});

// ---------- Users (for manager) ----------
app.get('/api/users', requireManager, (req, res) => {
    db.query('SELECT id, name, email, role, company, phone, address, employee_id, department, created_at FROM users', (err, results) => {
        if (err) return sendError(res, err, 'Unable to load accounts.');
        res.json(results);
    });
});

app.put('/api/users/:id', requireManager, auditManagerAction('account.updated', 'user', 'Manager updated an account profile.'), async (req, res) => {
    const userId = Number(req.params.id);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const company = typeof req.body.company === 'string' ? req.body.company.trim() : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Invalid user ID.' });
    }
    if (!name || !isValidEmail(email)) {
        return res.status(400).json({ error: 'Enter a name and valid email address.' });
    }
    try {
        const [result] = await dbp.query(
            'UPDATE users SET name = ?, email = ?, company = ?, phone = ? WHERE id = ?',
            [name.slice(0, 255), email, company.slice(0, 255) || null, phone.slice(0, 64) || null, userId]
        );
        if (result.affectedRows === 0) {
            const [existing] = await dbp.query('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
            if (existing.length === 0) return res.status(404).json({ error: 'Account not found.' });
        }
        res.json({ message: 'Account updated.' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'An account with that email already exists.' });
        }
        sendError(res, error, 'Unable to update account.');
    }
});

app.delete('/api/users/:id', requireManager, auditManagerAction('account.deleted', 'user', 'Manager deleted an account.'), async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Invalid user ID' });
    }
    if (userId === Number(req.auth.sub)) {
        return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    try {
        const [targets] = await dbp.query('SELECT role FROM users WHERE id = ? LIMIT 1', [userId]);
        if (targets.length === 0) return res.status(404).json({ error: 'User not found' });
        if (targets[0].role === 'manager') {
            const [managers] = await dbp.query("SELECT COUNT(*) AS total FROM users WHERE role = 'manager'");
            if (Number(managers[0].total) <= 1) {
                return res.status(409).json({ error: 'The last manager account cannot be deleted.' });
            }
        }
        await dbp.query('DELETE FROM users WHERE id = ?', [userId]);
        res.json({ message: 'User deleted' });
    } catch (err) {
        if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
            return res.status(409).json({ error: 'This user cannot be deleted because they have service requests.' });
        }
        sendError(res, err, 'Unable to delete user');
    }
});

// Customer registration
app.post('/api/register', (req, res) => {
    return res.status(410).json({ error: 'Customer self-registration is disabled. Please contact Ultimate Express to request an account.' });
});

app.post('/api/users', requireManager, auditManagerAction('account.created', 'user', 'Manager created a staff account.'), async (req, res) => {
    const { role, company, phone, address, employee_id, department } = req.body;
    if (role === 'customer') {
        return res.status(403).json({ error: 'Customer accounts must be created by a manager.' });
    }
    if (!['dispatcher', 'supervisor', 'manager'].includes(role)) {
        return res.status(400).json({ error: 'Invalid account role.' });
    }
    const normalizedEmail = String(req.body.email || '').trim().toLowerCase();
    const normalizedName = String(req.body.name || '').trim().slice(0, 255);
    if (!normalizedName || !isValidEmail(normalizedEmail)) {
        return res.status(400).json({ error: 'Enter a name and valid email address.' });
    }
    if (!hasEmailProvider()) {
        return res.status(503).json({ error: 'Configure an email provider before creating staff accounts.' });
    }
    const temporaryPassword = crypto.randomBytes(18).toString('base64url');
    const sql = `INSERT INTO users (name, email, password, role, company, phone, address, employee_id, department, must_change_password)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;
    try {
        const loginLink = getPublicPageUrl('login.html');
        const hashedPassword = await hashPassword(temporaryPassword);
        const [result] = await dbp.query(
            sql,
            [normalizedName, normalizedEmail, hashedPassword, role, company || null, phone || null, address || null, employee_id || null, department || null]
        );
        res.locals.auditEntityId = result.insertId;
        try {
            await sendEmail({
                to: normalizedEmail,
                subject: 'Your Ultimate Express account is ready',
                html: `<p>Hello ${escapeHtml(normalizedName)},</p>
                    <p>A ${escapeHtml(role)} account has been created for you.</p>
                    <p><a href="${escapeHtml(loginLink.toString())}">Sign in to Ultimate Express</a></p>
                    <p>Initial password: <strong>${escapeHtml(temporaryPassword)}</strong></p>
                    <p>Keep this password private. After signing in and verifying your email code, you must create a new password before accessing the dashboard.</p>`
            });
            res.status(201).json({ id: result.insertId, emailSent: true, message: 'Account created and login details emailed.' });
        } catch (emailError) {
            console.error('Staff account welcome email failed:', emailError);
            res.status(201).json({
                id: result.insertId,
                emailSent: false,
                message: 'Account created, but the welcome email could not be sent. Delete and recreate it after the email provider is fixed.'
            });
        }
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'An account with that email already exists.' });
        }
        sendError(res, error, 'Unable to create the account.');
    }
});

app.get('/api/customer-account-requests', requireManager, (req, res) => {
    db.query('SELECT * FROM customer_account_requests ORDER BY created_at DESC', (err, results) => {
        if (err) return sendError(res, err, 'Unable to load customer account requests.');
        res.json(results);
    });
});

app.post('/api/customer-account-requests', accountRequestLimiter, (req, res) => {
    const name = cleanText(req.body.name, 255);
    const email = cleanText(req.body.email, 254).toLowerCase();
    const message = cleanText(req.body.message, 2000);
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'Name, email, and message are required' });
    }
    if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const sql = `
        INSERT INTO customer_account_requests (name, email, company, phone, message, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
    `;
    db.query(sql, [name, email, cleanText(req.body.company, 255) || null, cleanText(req.body.phone, 64) || null, message], (err, result) => {
        if (err) return sendError(res, err, 'Unable to save your request.');
        res.status(201).json({ id: result.insertId, message: 'Request received' });
    });
});

app.put('/api/customer-account-requests/:id', requireManager, auditManagerAction('customer_request.updated', 'customer_account_request', 'Manager processed or declined a customer account request.'), (req, res) => {
    const { status } = req.body;
    if (!['pending', 'processed', 'declined'].includes(status)) {
        return res.status(400).json({ error: 'Invalid customer account request status' });
    }
    db.query('UPDATE customer_account_requests SET status = ? WHERE id = ?', [status, req.params.id], (err, result) => {
        if (err) return sendError(res, err, 'Unable to update the request.');
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Request not found' });
        res.json({ message: 'Request updated' });
    });
});

// Customer accounts get their own random first-time password (no shared default password).
app.post('/api/users/create-customer', requireManager, auditManagerAction('customer_account.created', 'user', 'Manager created a customer account.'), async (req, res) => {
    const { name, email, phone, company, requestId } = req.body;
    if (requestId === undefined && (!name || !email)) {
        return res.status(400).json({ error: 'Name and email are required' });
    }

    try {
        const temporaryPassword = crypto.randomBytes(18).toString('base64url');
        const hashedPassword = await hashPassword(temporaryPassword);
        const created = await withTransaction(async connection => {
            let customer = { name, email, phone, company };
            if (requestId !== undefined) {
                const parsedRequestId = Number(requestId);
                if (!Number.isInteger(parsedRequestId) || parsedRequestId <= 0) {
                    throw new HttpError(400, 'Invalid customer account request ID');
                }
                const [requests] = await connection.query(
                    'SELECT id, name, email, phone, company, status FROM customer_account_requests WHERE id = ? FOR UPDATE',
                    [parsedRequestId]
                );
                if (requests.length === 0) throw new HttpError(404, 'Customer account request not found');
                if (requests[0].status !== 'pending') throw new HttpError(409, 'Customer account request has already been handled');
                customer = requests[0];
            }
            if (!customer.name || !customer.email) throw new HttpError(400, 'Name and email are required');
            const normalizedEmail = String(customer.email).trim().toLowerCase();
            const normalizedName = String(customer.name).trim().slice(0, 255);
            if (!isValidEmail(normalizedEmail)) throw new HttpError(400, 'Enter a valid customer email address.');

            const [users] = await connection.query('SELECT id FROM users WHERE email = ? LIMIT 1 FOR UPDATE', [normalizedEmail]);
            if (users.length > 0) throw new HttpError(409, 'An account with that email already exists');

            const [result] = await connection.query(
                `INSERT INTO users (name, email, password, role, company, phone, verified, must_change_password)
                 VALUES (?, ?, ?, 'customer', ?, ?, 1, 1)`,
                [normalizedName, normalizedEmail, hashedPassword, customer.company || null, customer.phone || null]
            );
            if (requestId !== undefined) {
                await connection.query('UPDATE customer_account_requests SET status = ? WHERE id = ?', ['processed', Number(requestId)]);
            }
            return { id: result.insertId, name: normalizedName, email: normalizedEmail, phone: customer.phone || null, company: customer.company || null };
        });
        res.locals.auditEntityId = created.id;

        let emailSent = false;
        let message = 'Customer account created.';
        if (hasEmailProvider()) {
            try {
                const loginLink = getPublicPageUrl('login.html');
                await sendEmail({
                    to: created.email,
                    subject: 'Your Ultimate Express account is ready',
                    html: `<p>Hello ${escapeHtml(created.name)},</p>
                        <p>Your customer account has been created.</p>
                        <p><a href="${escapeHtml(loginLink.toString())}">Sign in to Ultimate Express</a></p>
                        <p>Initial password: <strong>${escapeHtml(temporaryPassword)}</strong></p>
                        <p>Keep this password private. After signing in and verifying your email code, you must create a new password before accessing the dashboard.</p>`
                });
                emailSent = true;
                message = 'Customer account created and login details emailed.';
            } catch (emailError) {
                console.error('Customer account email delivery failed:', emailError);
                message = 'Customer account created, but its login email could not be sent. Fix the email provider, then delete and recreate the account.';
            }
        } else {
            message = 'Customer account created, but no email provider is configured. Configure email, then delete and recreate the account.';
        }

        res.status(201).json({
            user: { ...created, role: 'customer' },
            emailSent,
            message
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'An account with that email already exists' });
        }
        sendError(res, error, 'Unable to create customer account.');
    }
});

// ---------- Partners ----------
app.get('/api/partners', requireManager, (req, res) => {
    db.query('SELECT * FROM partners ORDER BY created_at DESC', (err, results) => {
        if (err) return sendError(res, err, 'Unable to load partners.');
        res.json(results);
    });
});

app.post('/api/partners', requireManager, auditManagerAction('partner.created', 'partner', 'Manager added a business partner.'), (req, res) => {
    const company = cleanText(req.body.company, 255);
    if (!company) return res.status(400).json({ error: 'Company name is required.' });
    const sql = `INSERT INTO partners (company, contact_person, email, phone, partnership_type, contract_duration, agreement_details)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.query(sql, [
        company,
        cleanText(req.body.contact_person, 255) || null,
        cleanText(req.body.email, 255) || null,
        cleanText(req.body.phone, 64) || null,
        cleanText(req.body.partnership_type, 100) || null,
        cleanText(req.body.contract_duration, 100) || null,
        cleanText(req.body.agreement_details, 2000) || null
    ], (err, result) => {
        if (err) return sendError(res, err, 'Unable to save partner.');
        res.json({ id: result.insertId, message: 'Partner saved' });
    });
});

app.delete('/api/partners/:id', requireManager, auditManagerAction('partner.deleted', 'partner', 'Manager removed a business partner.'), (req, res) => {
    const partnerId = Number(req.params.id);
    if (!Number.isInteger(partnerId) || partnerId <= 0) {
        return res.status(400).json({ error: 'Invalid partner ID.' });
    }
    db.query('DELETE FROM partners WHERE id = ?', [partnerId], (error, result) => {
        if (error) return sendError(res, error, 'Unable to remove partner.');
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Partner not found.' });
        res.json({ message: 'Partner removed.' });
    });
});

// ---------- Manager analytics (calculated from the live database) ----------
app.get('/api/manager/report', requireManager, async (req, res) => {
    const requestedYear = Number(req.query.year) || new Date().getFullYear();
    if (requestedYear < 2000 || requestedYear > 2100) {
        return res.status(400).json({ error: 'Year must be between 2000 and 2100' });
    }

    try {
        const [monthly] = await dbp.query(`
            SELECT MONTH(COALESCE(pickup_date, created_at)) AS month,
                   COUNT(*) AS transactions,
                   SUM(status = 'completed') AS completed
            FROM service_requests
            WHERE YEAR(COALESCE(pickup_date, created_at)) = ?
            GROUP BY MONTH(COALESCE(pickup_date, created_at))
            ORDER BY month
        `, [requestedYear]);
        const [customerActivity] = await dbp.query(`
            SELECT u.id AS customer_id, u.name AS customer_name, u.company, u.email,
                   COUNT(sr.id) AS total_requests,
                   SUM(sr.status = 'completed') AS completed_requests
            FROM service_requests sr
            JOIN users u ON u.id = sr.customer_id
            WHERE YEAR(COALESCE(sr.pickup_date, sr.created_at)) = ?
            GROUP BY u.id, u.name, u.company, u.email
            ORDER BY total_requests DESC, completed_requests DESC, customer_name ASC
        `, [requestedYear]);
        const [monthlyPayments] = await dbp.query(`
            SELECT MONTH(paid_at) AS month, SUM(paid_amount) AS paid_revenue,
                   COUNT(*) AS paid_orders
            FROM service_requests
            WHERE paid_amount IS NOT NULL AND YEAR(paid_at) = ?
            GROUP BY MONTH(paid_at)
            ORDER BY month
        `, [requestedYear]);
        const [quarterlyTransactions] = await dbp.query(`
            SELECT QUARTER(COALESCE(pickup_date, created_at)) AS quarter, COUNT(*) AS total_transactions
            FROM service_requests
            WHERE YEAR(COALESCE(pickup_date, created_at)) = ?
            GROUP BY QUARTER(COALESCE(pickup_date, created_at))
        `, [requestedYear]);
        const [quarterlyPayments] = await dbp.query(`
            SELECT QUARTER(paid_at) AS quarter, SUM(paid_amount) AS paid_revenue
            FROM service_requests
            WHERE paid_amount IS NOT NULL AND YEAR(paid_at) = ?
            GROUP BY QUARTER(paid_at)
        `, [requestedYear]);
        const [customerPayments] = await dbp.query(`
            SELECT u.id AS customer_id, u.name AS customer_name, u.company,
                   SUM(sr.paid_amount) AS total_paid, COUNT(*) AS paid_orders
            FROM service_requests sr
            JOIN users u ON u.id = sr.customer_id
            WHERE sr.paid_amount IS NOT NULL AND YEAR(sr.paid_at) = ?
            GROUP BY u.id, u.name, u.company
            ORDER BY total_paid DESC, paid_orders DESC, customer_name ASC
        `, [requestedYear]);
        const [statuses] = await dbp.query(`
            SELECT COALESCE(NULLIF(status, ''), 'pending') AS status, COUNT(*) AS total
            FROM service_requests
            GROUP BY COALESCE(NULLIF(status, ''), 'pending')
        `);
        const [serviceTypes] = await dbp.query(`
            SELECT COALESCE(NULLIF(cargo_type, ''), 'Unspecified') AS service_type, COUNT(*) AS total
            FROM service_requests
            WHERE YEAR(COALESCE(pickup_date, created_at)) = ?
            GROUP BY COALESCE(NULLIF(cargo_type, ''), 'Unspecified')
            ORDER BY total DESC
        `, [requestedYear]);
        // "pending" now includes brand-new requests; "ongoing" includes approved ones.
        const [summary] = await dbp.query(`
            SELECT COUNT(*) AS total_transactions,
                   SUM(status = 'completed') AS completed,
                   SUM(status IN ('ongoing', 'approved')) AS ongoing,
                   SUM(status IN ('pending', 'new') OR status IS NULL OR status = '') AS pending
            FROM service_requests
            WHERE YEAR(COALESCE(pickup_date, created_at)) = ?
        `, [requestedYear]);
        const [paymentSummary] = await dbp.query(`
            SELECT COALESCE(SUM(paid_amount), 0) AS paid_revenue, COUNT(*) AS paid_orders
            FROM service_requests
            WHERE paid_amount IS NOT NULL AND YEAR(paid_at) = ?
        `, [requestedYear]);
        const [users] = await dbp.query('SELECT COUNT(*) AS total_users FROM users');
        const [partners] = await dbp.query('SELECT COUNT(*) AS total_partners FROM partners');

        const monthlyTransactions = Array.from({ length: 12 }, (_, index) => {
            const row = monthly.find(item => Number(item.month) === index + 1);
            return row ? Number(row.transactions) : 0;
        });
        const monthlyCompleted = Array.from({ length: 12 }, (_, index) => {
            const row = monthly.find(item => Number(item.month) === index + 1);
            return row ? Number(row.completed || 0) : 0;
        });
        const monthlyPaidRevenue = Array.from({ length: 12 }, (_, index) => {
            const row = monthlyPayments.find(item => Number(item.month) === index + 1);
            return row ? Number(row.paid_revenue || 0) : 0;
        });
        const monthlyPaidOrders = Array.from({ length: 12 }, (_, index) => {
            const row = monthlyPayments.find(item => Number(item.month) === index + 1);
            return row ? Number(row.paid_orders || 0) : 0;
        });
        const today = new Date();
        const quarterlySummary = Array.from({ length: 4 }, (_, index) => {
            const quarter = index + 1;
            const revenueRow = quarterlyPayments.find(item => Number(item.quarter) === quarter);
            const transactionRow = quarterlyTransactions.find(item => Number(item.quarter) === quarter);
            const quarterStart = new Date(Date.UTC(requestedYear, index * 3, 1));
            const quarterEnd = new Date(Date.UTC(requestedYear, index * 3 + 3, 0));
            const lastElapsedDay = requestedYear < today.getUTCFullYear()
                ? quarterEnd
                : requestedYear > today.getUTCFullYear()
                    ? null
                    : new Date(Math.min(quarterEnd.getTime(), Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
            const elapsedDays = lastElapsedDay && lastElapsedDay >= quarterStart
                ? Math.floor((lastElapsedDay - quarterStart) / 86_400_000) + 1
                : 0;
            const paidRevenue = Number(revenueRow?.paid_revenue || 0);
            return {
                quarter,
                total_transactions: Number(transactionRow?.total_transactions || 0),
                paid_revenue: paidRevenue,
                average_daily_revenue: elapsedDays ? paidRevenue / elapsedDays : 0
            };
        });

        res.json({
            year: requestedYear,
            summary: {
                ...summary[0],
                total_transactions: Number(summary[0].total_transactions || 0),
                completed: Number(summary[0].completed || 0),
                ongoing: Number(summary[0].ongoing || 0),
                pending: Number(summary[0].pending || 0),
                total_users: Number(users[0].total_users || 0),
                total_partners: Number(partners[0].total_partners || 0),
                paid_revenue: Number(paymentSummary[0].paid_revenue || 0),
                paid_orders: Number(paymentSummary[0].paid_orders || 0)
            },
            monthlyTransactions,
            monthlyCompleted,
            monthlyPaidRevenue,
            monthlyPaidOrders,
            quarterlySummary,
            statuses: statuses.map(row => ({ status: row.status, total: Number(row.total) })),
            serviceTypes: serviceTypes.map(row => ({ service_type: row.service_type, total: Number(row.total) })),
            customerActivity: customerActivity.map(row => ({
                ...row,
                total_requests: Number(row.total_requests || 0),
                completed_requests: Number(row.completed_requests || 0)
            })),
            customerPayments: customerPayments.map(row => ({
                ...row,
                total_paid: Number(row.total_paid || 0),
                paid_orders: Number(row.paid_orders || 0)
            })),
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        sendError(res, error, 'Unable to generate manager report');
    }
});

// ---------- Fallbacks ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

process.on('unhandledRejection', reason => console.error('Unhandled promise rejection:', reason));

// ---------- Start server ----------
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
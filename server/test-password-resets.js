// Full HTTP + MySQL regression test. Uses its own temporary localhost database
// instance and captures mail in memory; never connects to Railway or sends email.
// Requires MySQL Server (MYSQLD_PATH can select its installed mysqld binary).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const passwordResetStore = require('./password-reset-store');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-password-reset-test-'));
const binary = process.env.MYSQLD_PATH || (process.platform === 'win32'
    ? 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqld.exe' : 'mysqld');
const mysqlBase = path.isAbsolute(binary) ? path.dirname(path.dirname(binary)) : null;
const logs = [], emails = [];
let databaseProcess, applicationProcess, connection;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function child(command, args, options = {}) {
    const process = spawn(command, args, { windowsHide: true, ...options });
    process.stdout?.on('data', chunk => logs.push(chunk.toString()));
    process.stderr?.on('data', chunk => logs.push(chunk.toString()));
    return process;
}

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function main() {
    const dataDirectory = path.join(work, 'data');
    fs.mkdirSync(dataDirectory);
    const mysqlPaths = [...(mysqlBase ? [`--basedir=${mysqlBase}`] : []), `--datadir=${dataDirectory}`];
    const initialize = child(binary, ['--no-defaults', '--initialize-insecure', ...mysqlPaths]);
    await new Promise((resolve, reject) => {
        initialize.once('error', reject);
        initialize.once('exit', code => code === 0 ? resolve() : reject(new Error(`MySQL initialization failed (${code}).`)));
    });

    const databasePort = await freePort(), applicationPort = await freePort();
    const databasePassword = crypto.randomBytes(24).toString('hex');
    databaseProcess = child(binary, ['--no-defaults', ...mysqlPaths, `--port=${databasePort}`,
        '--bind-address=127.0.0.1', '--mysqlx=0', '--skip-log-bin', '--innodb-buffer-pool-size=33554432']);
    for (let attempt = 0; attempt < 120; attempt++) {
        try {
            connection = await mysql.createConnection({ host: '127.0.0.1', port: databasePort, user: 'root', multipleStatements: true });
            break;
        } catch (error) { if (attempt === 119) throw error; await delay(250); }
    }
    await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [databasePassword]);
    await connection.query("SET time_zone = '+08:00'");
    await connection.query('CREATE DATABASE ue_password_reset_test');
    await connection.query('USE ue_password_reset_test');
    await connection.query(fs.readFileSync(path.join(__dirname, 'railway-schema.sql'), 'utf8'));
    // This table belongs only to the fresh temporary test database above.
    await connection.query('DROP TABLE customer_password_resets');
    await assert.rejects(connection.query('SELECT COUNT(*) FROM customer_password_resets'), error => error.code === 'ER_NO_SUCH_TABLE');

    const originalPassword = 'Original regression password!';
    const newPassword = 'Changed regression password!';
    const originalHash = await bcrypt.hash(originalPassword, 12);
    for (const [id, role] of [[1, 'customer'], [2, 'manager'], [3, 'customer']]) {
        await connection.execute(
            'INSERT INTO users (id,name,email,password,role,verified,must_change_password) VALUES (?,?,?,?,?,1,1)',
            [id, `Reset test ${role} ${id}`, `${role}${id}@example.invalid`, originalHash, role]
        );
    }
    const challengeId = crypto.randomUUID();
    await connection.execute('INSERT INTO login_code_challenges (challenge_id,user_id,code_hash,expires_at,created_at) VALUES (?,1,?,DATE_ADD(NOW(), INTERVAL 10 MINUTE),DATE_SUB(NOW(), INTERVAL 2 MINUTE))',
        [challengeId, '0'.repeat(64)]);

    const mailHook = path.join(work, 'capture-mail.cjs');
    fs.writeFileSync(mailHook, `const mail = require(${JSON.stringify(require.resolve('@sendgrid/mail'))});\nmail.setApiKey = () => {};\nmail.send = async message => { process.send({ kind: 'email', message }); return [{ statusCode: 202 }]; };\n`);
    const environment = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(databasePort), DB_USER: 'root',
        DB_PASSWORD: databasePassword, DB_NAME: 'ue_password_reset_test', PORT: String(applicationPort),
        SESSION_SECRET: crypto.randomBytes(40).toString('hex'), PUBLIC_BASE_URL: 'https://www.ultimateexpress.online',
        GMAIL_USER: '', GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: '', RESEND_API_KEY: '',
        SENDGRID_API_KEY: 'isolated-test-only', SENDGRID_FROM_EMAIL: 'test@example.invalid', EMAIL_FROM: 'test@example.invalid' };
    applicationProcess = child(process.execPath, ['--require', mailHook, path.join(__dirname, 'server.js')],
        { cwd: __dirname, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    applicationProcess.on('message', message => { if (message.kind === 'email') emails.push(message.message); });
    const base = `http://127.0.0.1:${applicationPort}/api`;
    for (let attempt = 0; attempt < 120; attempt++) {
        try { if ((await fetch(`http://127.0.0.1:${applicationPort}/health`)).ok) break; } catch {}
        if (attempt === 119) throw new Error('Test application did not start.');
        await delay(250);
    }
    // Separate local test client addresses keep the shared IP limiter from
    // hiding token/expiry assertions; the database per-account limit is tested.
    let requestNumber = 0;
    async function post(endpoint, body) {
        return fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json',
            'X-Forwarded-For': `127.0.0.${2 + requestNumber++ % 200}` }, body: JSON.stringify(body) });
    }
    async function resetToken(email) {
        const count = emails.length;
        const response = await post('/customer/password-reset/request', { email });
        assert.equal(response.status, 200);
        for (let attempt = 0; emails.length === count && attempt < 30; attempt++) await delay(20);
        assert.equal(emails.length, count + 1, 'Reset email is captured without sending externally');
        const link = new URL(emails.at(-1).html.match(/href="([^"]+)"/)[1]);
        assert.equal(link.origin, 'https://www.ultimateexpress.online');
        assert.equal(link.pathname, '/reset-password.html');
        return link.searchParams.get('token');
    }
    const hash = token => crypto.createHash('sha256').update(token).digest('hex');

    assert.equal((await post('/customer/password-reset/request', { email: 'invalid' })).status, 400);
    for (const email of ['unknown@example.invalid', 'manager2@example.invalid']) {
        assert.equal((await post('/customer/password-reset/request', { email })).status, 200);
    }
    assert.equal(emails.length, 0, 'Unknown and non-customer accounts receive no reset email');
    const token = await resetToken(' CUSTOMER1@EXAMPLE.INVALID ');
    const [stored] = await connection.execute('SELECT token_hash,consumed_at,TIMESTAMPDIFF(MINUTE,NOW(),expires_at) AS minutes_left FROM customer_password_resets WHERE user_id=1');
    assert.equal(stored[0].token_hash, hash(token));
    assert.notEqual(stored[0].token_hash, token, 'Only a hash is stored');
    assert.ok(stored[0].minutes_left >= 29 && stored[0].minutes_left <= 30);
    assert.equal((await post('/customer/password-reset/confirm', { token, password: 'short' })).status, 400);
    assert.equal((await post('/customer/password-reset/confirm', { token: 'X'.repeat(43), password: newPassword })).status, 400);
    assert.equal((await post('/customer/password-reset/confirm', { token, password: newPassword })).status, 200);
    const [[user]] = await connection.execute('SELECT password,must_change_password FROM users WHERE id=1');
    assert.ok(await bcrypt.compare(newPassword, user.password));
    assert.ok(!(await bcrypt.compare(originalPassword, user.password)));
    assert.equal(user.must_change_password, 0);
    const [[challenge]] = await connection.execute('SELECT consumed_at FROM login_code_challenges WHERE challenge_id=?', [challengeId]);
    assert.ok(challenge.consumed_at, 'Password reset invalidates pending login codes');
    assert.equal((await post('/customer/password-reset/confirm', { token, password: 'Another regression password!' })).status, 400);
    assert.equal((await post('/login', { email: 'customer1@example.invalid', password: originalPassword })).status, 401);
    const login = await post('/login', { email: 'customer1@example.invalid', password: newPassword });
    assert.equal(login.status, 200);assert.equal((await login.json()).requiresCode, true);

    const replaced = await resetToken('customer1@example.invalid');
    const expiring = await resetToken('customer1@example.invalid');
    assert.equal((await post('/customer/password-reset/confirm', { token: replaced, password: newPassword })).status, 400);
    const emailCount = emails.length;
    assert.equal((await post('/customer/password-reset/request', { email: 'customer1@example.invalid' })).status, 200);
    assert.equal(emails.length, emailCount, 'Only three reset emails are issued per account per hour');
    await connection.execute('UPDATE customer_password_resets SET expires_at=DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE token_hash=?', [hash(expiring)]);
    assert.equal((await post('/customer/password-reset/confirm', { token: expiring, password: newPassword })).status, 400);
    const otherToken = await resetToken('customer3@example.invalid');
    const concurrent = await Promise.all([post('/customer/password-reset/confirm', { token: otherToken, password: newPassword }),
        post('/customer/password-reset/confirm', { token: otherToken, password: newPassword })]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 400], 'Concurrent use succeeds only once');
    const [[unchanged]] = await connection.execute('SELECT password FROM users WHERE id=2');
    assert.equal(unchanged.password, originalHash, 'Staff password remains unchanged');

    // Check legacy signed INT IDs as well as the fresh BIGINT UNSIGNED schema.
    await connection.query('CREATE DATABASE ue_password_reset_legacy');
    await connection.query('USE ue_password_reset_legacy');
    await connection.query('CREATE TABLE users (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255)) ENGINE=InnoDB');
    const ensureLegacy = passwordResetStore(connection);
    await Promise.all([ensureLegacy(), ensureLegacy()]);
    const [[legacyColumn]] = await connection.query("SHOW COLUMNS FROM customer_password_resets LIKE 'user_id'");
    assert.match(legacyColumn.Type, /^int(?:\(\d+\))?$/);
    await connection.execute('INSERT INTO users (name) VALUES (?)', ['Existing legacy customer']);
    await ensureLegacy();
    const [[legacyUser]] = await connection.query('SELECT name FROM users WHERE id=1');
    assert.equal(legacyUser.name, 'Existing legacy customer');
    const evidence = { passed: true, checkedAt: new Date().toISOString(), database: 'isolated temporary MySQL',
        checks: ['missing-table recovery', 'legacy INT and BIGINT UNSIGNED IDs', 'email validation and account privacy',
            'captured email with custom-domain link', 'hashed token and expiry', 'password update and new-password login',
            'pending login-code invalidation', 'used, replaced and expired links rejected', 'per-account request limit',
            'concurrent one-use token', 'existing accounts preserved'] };
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log('Password-reset MySQL/HTTP tests passed: ' + evidence.checks.join('; ') + '.');
    console.log('Local evidence: ' + path.join(work, 'result.json'));
}

main().catch(error => {
    console.error(error.stack || error.message);
    console.error(logs.join('').slice(-3500));
    process.exitCode = 1;
}).finally(async () => {
    applicationProcess?.kill();
    if (connection) {
        try { await connection.query('SHUTDOWN'); } catch {}
        await connection.end().catch(() => {});
    }
    if (databaseProcess && !databaseProcess.killed) databaseProcess.kill();
});

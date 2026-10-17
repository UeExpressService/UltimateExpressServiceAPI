require('dotenv').config();
const crypto = require('crypto');
const net = require('net');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function findAvailablePort() {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', resolve);
    });
    const { port } = probe.address();
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    return port;
}

async function readCodeFromEmail(html) {
    const match = html.match(/>(\d{6})<\/p>/) || html.match(/letter-spacing:6px;">(\d{6})<\/p>/);
    if (!match) throw new Error('Test email did not include a six-digit login code.');
    return match[1];
}

async function readInitialPasswordFromEmail(html) {
    const match = html.match(/Initial password: <strong>([^<]+)<\/strong>/);
    if (!match) throw new Error('Welcome email did not include an initial password.');
    return match[1];
}

async function testLoginCodes() {
    const port = await findAvailablePort();
    process.env.PORT = String(port);
    process.env.GMAIL_USER = '';
    process.env.GMAIL_CLIENT_ID = '';
    process.env.GMAIL_CLIENT_SECRET = '';
    process.env.GMAIL_REFRESH_TOKEN = '';
    process.env.RESEND_API_KEY = '';
    process.env.SENDGRID_API_KEY = 'test-only';
    process.env.SENDGRID_FROM_EMAIL = 'test@example.invalid';

    let sentMessage;
    const sendgrid = require('@sendgrid/mail');
    sendgrid.setApiKey = () => {};
    sendgrid.send = async message => {
        sentMessage = message;
        return [{ statusCode: 202 }];
    };

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    const challengeIds = [];
    const createdUserIds = [];

    try {
        const [customers] = await connection.execute(
            'SELECT id, password FROM users WHERE email = ? LIMIT 1',
            ['customer.test@ultimateexpress.local']
        );
        const [managers] = await connection.execute(
            'SELECT id, password FROM users WHERE email = ? LIMIT 1',
            ['manager.test@ultimateexpress.local']
        );
        const matchesTestPassword = async stored =>
            stored.startsWith('$2') ? bcrypt.compare('Test123!', stored) : stored === 'Test123!';
        if (!customers.length || !managers.length ||
            !(await matchesTestPassword(customers[0].password)) ||
            !(await matchesTestPassword(managers[0].password))) {
            throw new Error('Run npm run seed:test-accounts before this test.');
        }

        require('./server');
        const baseUrl = `http://127.0.0.1:${port}/api`;

        let response;
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                response = await fetch(`${baseUrl}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: 'unknown@example.invalid', password: 'wrong' })
                });
                break;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        if (!response) throw new Error('Login API did not start.');

        response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'customer.test@ultimateexpress.local', password: 'Test123!' })
        });
        const challenge = await response.json();
        if (!response.ok || !challenge.challengeId || !sentMessage) {
            throw new Error(`Code request failed: ${challenge.error || response.status}`);
        }
        challengeIds.push(challenge.challengeId);
        const customerCode = await readCodeFromEmail(sentMessage.html);

        response = await fetch(`${baseUrl}/login/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: challenge.challengeId, code: customerCode })
        });
        const customerSession = await response.json();
        if (!response.ok || customerSession.role !== 'customer' || !customerSession.authToken) {
            throw new Error(`Valid email code was rejected: ${customerSession.error || response.status}`);
        }

        response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'manager.test@ultimateexpress.local', password: 'Test123!' })
        });
        const managerChallenge = await response.json();
        if (!response.ok || !managerChallenge.challengeId) {
            throw new Error(`Manager code request failed: ${managerChallenge.error || response.status}`);
        }
        challengeIds.push(managerChallenge.challengeId);
        const managerCode = await readCodeFromEmail(sentMessage.html);

        response = await fetch(`${baseUrl}/login/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: managerChallenge.challengeId, code: managerCode })
        });
        const managerSession = await response.json();
        if (!response.ok || managerSession.role !== 'manager' || !managerSession.authToken) {
            throw new Error(`Manager code verification failed: ${managerSession.error || response.status}`);
        }

        const customerEmail = `welcome.customer.${crypto.randomUUID()}@ultimateexpress.local`;
        response = await fetch(`${baseUrl}/users/create-customer`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${managerSession.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: 'Customer Welcome Email Test',
                email: customerEmail,
                phone: '09170000000'
            })
        });
        const createdCustomer = await response.json();
        if (!response.ok || !createdCustomer.emailSent) {
            throw new Error(`Customer account creation failed: ${createdCustomer.error || createdCustomer.message || response.status}`);
        }
        const customerInitialPassword = await readInitialPasswordFromEmail(sentMessage.html);
        const [customerRows] = await connection.execute(
            'SELECT id, password, must_change_password FROM users WHERE email = ? LIMIT 1',
            [customerEmail]
        );
        if (customerRows.length !== 1 ||
            !(await bcrypt.compare(customerInitialPassword, customerRows[0].password)) ||
            Number(customerRows[0].must_change_password) !== 1) {
            throw new Error('Customer account password did not match the stored bcrypt hash or email content.');
        }
        createdUserIds.push(customerRows[0].id);

        response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: customerEmail, password: customerInitialPassword })
        });
        const customerChallenge = await response.json();
        if (!response.ok || !customerChallenge.challengeId) {
            throw new Error(`Customer account could not start email-code login: ${customerChallenge.error || response.status}`);
        }
        challengeIds.push(customerChallenge.challengeId);

        const staffEmail = `welcome.staff.${crypto.randomUUID()}@ultimateexpress.local`;
        response = await fetch(`${baseUrl}/users`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${managerSession.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: 'Welcome Email Test',
                email: staffEmail,
                role: 'dispatcher',
                phone: '09170000000'
            })
        });
        const createdUser = await response.json();
        if (!response.ok || !createdUser.emailSent) {
            throw new Error(`Staff account creation failed: ${createdUser.error || createdUser.message || response.status}`);
        }
        const staffInitialPassword = await readInitialPasswordFromEmail(sentMessage.html);
        const [staffRows] = await connection.execute(
            'SELECT id, password, must_change_password FROM users WHERE email = ? LIMIT 1',
            [staffEmail]
        );
        if (staffRows.length !== 1 ||
            !(await bcrypt.compare(staffInitialPassword, staffRows[0].password)) ||
            Number(staffRows[0].must_change_password) !== 1) {
            throw new Error('Staff account password did not match the stored bcrypt hash or email content.');
        }
        createdUserIds.push(staffRows[0].id);

        response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: staffEmail, password: staffInitialPassword })
        });
        const staffChallenge = await response.json();
        if (!response.ok || !staffChallenge.challengeId) {
            throw new Error(`Staff account could not start email-code login: ${staffChallenge.error || response.status}`);
        }
        challengeIds.push(staffChallenge.challengeId);

        console.log('Passed: manager-created staff and customer accounts store the same bcrypt password they email as the temporary login password.');
    } finally {
        if (challengeIds.length) {
            await connection.execute(
                `DELETE FROM login_code_challenges WHERE challenge_id IN (${challengeIds.map(() => '?').join(',')})`,
                challengeIds
            );
        }
        for (const userId of createdUserIds) {
            await connection.execute('DELETE FROM users WHERE id = ?', [userId]);
        }
        await connection.end();
    }
}

testLoginCodes().catch(error => {
    console.error('Login-code integration test failed:', error.message);
    process.exitCode = 1;
}).finally(() => process.exit(process.exitCode || 0));

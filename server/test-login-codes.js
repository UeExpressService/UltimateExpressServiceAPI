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
    let resetToken = '';
    let customerId = null;
    let createdUserId = null;

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
        customerId = customers[0].id;

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
            body: JSON.stringify({
                email: 'customer.test@ultimateexpress.local',
                password: 'Test123!'
            })
        });
        const challenge = await response.json();
        if (!response.ok || !challenge.challengeId || !sentMessage) {
            throw new Error(`Code request failed: ${challenge.error || response.status}`);
        }
        challengeIds.push(challenge.challengeId);
        const emailHtml = sentMessage.html;
        const codeMatch = emailHtml.match(/letter-spacing:6px;">(\d{6})<\/p>/);
        if (!codeMatch) throw new Error('Test email did not include a six-digit login code.');

        response = await fetch(`${baseUrl}/login/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: challenge.challengeId, code: codeMatch[1] })
        });
        const customerSession = await response.json();
        if (!response.ok || customerSession.role !== 'customer' || !customerSession.authToken) {
            throw new Error(`Valid email code was rejected: ${customerSession.error || response.status}`);
        }
        const unauthenticatedFleet = await fetch(`${baseUrl}/trucks`);
        if (unauthenticatedFleet.status !== 401) {
            throw new Error('Fleet endpoints accepted a request without a JWT.');
        }
        response = await fetch(`${baseUrl}/service-requests`, {
            headers: { Authorization: `Bearer ${customerSession.authToken}` }
        });
        const customerRequests = await response.json();
        if (!response.ok || customerRequests.some(request => Number(request.customer_id) !== Number(customerSession.id))) {
            throw new Error('Customer service-request access was not scoped to the signed-in account.');
        }
        const forbiddenFleet = await fetch(`${baseUrl}/drivers`, {
            headers: { Authorization: `Bearer ${customerSession.authToken}` }
        });
        if (forbiddenFleet.status !== 403) throw new Error('Customer role was allowed to read fleet records.');
        const forbiddenRequest = await fetch(`${baseUrl}/service-requests`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${customerSession.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ customer_id: managers[0].id })
        });
        if (forbiddenRequest.status !== 403) throw new Error('Customer was allowed to submit a request for another account.');
        const unacceptedRequest = await fetch(`${baseUrl}/service-requests`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${customerSession.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ customer_id: customerSession.id, terms_accepted: false })
        });
        if (unacceptedRequest.status !== 400) throw new Error('Customer was allowed to submit a request without accepting the service terms.');

        const wrongPassword = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'customer.test@ultimateexpress.local',
                password: 'wrong'
            })
        });
        if (wrongPassword.status !== 401) throw new Error('Wrong password was not rejected.');

        const unknownReset = await fetch(`${baseUrl}/customer/password-reset/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'unknown@example.invalid' })
        });
        const unknownResetResult = await unknownReset.json();
        const customerReset = await fetch(`${baseUrl}/customer/password-reset/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'customer.test@ultimateexpress.local' })
        });
        const customerResetResult = await customerReset.json();
        if (!unknownReset.ok || !customerReset.ok ||
            unknownResetResult.message !== customerResetResult.message ||
            !sentMessage?.html.includes('Confirm password reset')) {
            throw new Error('Customer password reset request did not preserve a generic response and email a confirmation link.');
        }
        const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
        if (!sentMessage.html.includes(new URL('reset-password.html', `${publicBaseUrl}/`).toString())) {
            throw new Error('Password reset link did not preserve the configured public base path.');
        }
        const resetLinkMatch = sentMessage.html.match(/reset-password\.html\?token=([A-Za-z0-9_-]+)/);
        if (!resetLinkMatch) throw new Error('Password-reset email did not include a one-time reset link.');
        resetToken = resetLinkMatch[1];
        response = await fetch(`${baseUrl}/customer/password-reset/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: resetToken, password: 'TemporaryReset!123' })
        });
        const resetResult = await response.json();
        if (!response.ok || !resetResult.message?.includes('Password changed')) {
            throw new Error(`Customer password reset failed: ${resetResult.error || response.status}`);
        }
        const usedResetLink = await fetch(`${baseUrl}/customer/password-reset/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: resetToken, password: 'AnotherReset!123' })
        });
        if (usedResetLink.status !== 400) throw new Error('A consumed password-reset link was accepted a second time.');

        const storedCode = '735193';
        const managerChallengeId = crypto.randomUUID();
        challengeIds.push(managerChallengeId);
        const managerHash = crypto.createHmac('sha256', process.env.SESSION_SECRET)
            .update(`${managerChallengeId}:${storedCode}`)
            .digest('hex');
        await connection.execute(
            `INSERT INTO login_code_challenges (challenge_id, user_id, code_hash, expires_at)
             VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
            [managerChallengeId, managers[0].id, managerHash]
        );
        response = await fetch(`${baseUrl}/login/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: managerChallengeId, code: storedCode })
        });
        const managerSession = await response.json();
        if (!response.ok || managerSession.role !== 'manager' || !managerSession.authToken) {
            throw new Error(`Manager code verification failed: ${managerSession.error || response.status}`);
        }
        if (managerSession.authToken.split('.').length !== 3) {
            throw new Error('Manager session token is not a three-part JWT.');
        }
        const unauthorizedUsers = await fetch(`${baseUrl}/users`);
        if (unauthorizedUsers.status !== 401) throw new Error('Manager API accepted a request without a JWT.');
        response = await fetch(`${baseUrl}/users`, {
            headers: { Authorization: `Bearer ${managerSession.authToken}` }
        });
        if (!response.ok) throw new Error('Manager session token was not accepted.');
        const temporaryEmail = `welcome.${crypto.randomUUID()}@ultimateexpress.local`;
        response = await fetch(`${baseUrl}/users`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${managerSession.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: 'Welcome Email Test',
                email: temporaryEmail,
                role: 'dispatcher',
                phone: '09170000000'
            })
        });
        const createdUser = await response.json();
        createdUserId = createdUser.id || null;
        const expectedLoginLink = new URL('login.html', `${publicBaseUrl}/`).toString();
        if (!response.ok || !createdUser.emailSent || !sentMessage?.html.includes(expectedLoginLink)) {
            throw new Error(`Staff welcome email failed: ${createdUser.message || createdUser.error || response.status}`);
        }
        const initialPassword = sentMessage.html.match(/Initial password: <strong>([^<]+)<\/strong>/)?.[1];
        const [createdUserRows] = await connection.execute(
            'SELECT password, must_change_password FROM users WHERE id = ?',
            [createdUserId]
        );
        if (!initialPassword || createdUserRows.length !== 1 ||
            !(await bcrypt.compare(initialPassword, createdUserRows[0].password)) ||
            Number(createdUserRows[0].must_change_password) !== 1) {
            throw new Error('Staff account password was not bcrypt-hashed or emailed.');
        }
        response = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: temporaryEmail, password: initialPassword })
        });
        const staffChallenge = await response.json();
        const staffCode = sentMessage?.html.match(/>(\d{6})<\/p>/)?.[1];
        if (!response.ok || !staffCode) {
            throw new Error(`New staff account could not start email-code login: ${staffChallenge.error || response.status}`);
        }
        challengeIds.push(staffChallenge.challengeId);
        response = await fetch(`${baseUrl}/login/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: staffChallenge.challengeId, code: staffCode })
        });
        const forcedSession = await response.json();
        if (!response.ok || forcedSession.mustChangePassword !== true || !forcedSession.authToken) {
            throw new Error(`New staff account was not required to set its own password: ${forcedSession.error || response.status}`);
        }
        response = await fetch(`${baseUrl}/drivers`, {
            headers: { Authorization: `Bearer ${forcedSession.authToken}` }
        });
        if (response.status !== 403) {
            throw new Error('A new account accessed a protected dashboard before changing its password.');
        }
        response = await fetch(`${baseUrl}/account/first-login-password`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${forcedSession.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ password: 'FirstLoginPassword!2026', confirmPassword: 'FirstLoginPassword!2026' })
        });
        const changedSession = await response.json();
        if (!response.ok || !changedSession.authToken) {
            throw new Error(`New account password setup failed: ${changedSession.error || response.status}`);
        }
        response = await fetch(`${baseUrl}/drivers`, {
            headers: { Authorization: `Bearer ${changedSession.authToken}` }
        });
        if (!response.ok) throw new Error('New account could not access its role-protected API after password setup.');
        const [updatedPasswordRows] = await connection.execute(
            'SELECT password, must_change_password FROM users WHERE id = ?',
            [createdUserId]
        );
        if (updatedPasswordRows.length !== 1 ||
            Number(updatedPasswordRows[0].must_change_password) !== 0 ||
            !(await bcrypt.compare('FirstLoginPassword!2026', updatedPasswordRows[0].password))) {
            throw new Error('First-login password was not stored securely or the setup flag was not cleared.');
        }
        response = await fetch(`${baseUrl}/users/${createdUserId}`, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${managerSession.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: 'Welcome Email Test Updated',
                email: temporaryEmail,
                phone: '09170000000',
                company: 'Test Edit'
            })
        });
        if (!response.ok) throw new Error('Manager account edit endpoint rejected a valid update.');
        response = await fetch(`${baseUrl}/users/${createdUserId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${managerSession.authToken}` }
        });
        if (!response.ok) throw new Error('Manager could not remove its temporary account test record.');
        let auditRows = [];
        for (let attempt = 0; attempt < 10 && auditRows.length < 3; attempt += 1) {
            const [rows] = await connection.execute(
                `SELECT action FROM manager_audit_logs
                 WHERE actor_user_id = ? AND entity_type = 'user' AND entity_id = ?
                   AND action IN ('account.created', 'account.updated', 'account.deleted')`,
                [managers[0].id, String(createdUserId)]
            );
            auditRows = rows;
            if (auditRows.length < 3) await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (new Set(auditRows.map(row => row.action)).size < 3) {
            throw new Error('Manager account create, update, and delete activities were not audited.');
        }
        createdUserId = null;
        if (managerSession.authToken.split('.').length !== 3) {
            throw new Error('Manager session token is not a three-part JWT.');
        }
        response = await fetch(`${baseUrl}/manager/report?year=${new Date().getFullYear()}`, {
            headers: { Authorization: `Bearer ${managerSession.authToken}` }
        });
        const managerReport = await response.json();
        if (!response.ok || managerReport.quarterlySummary?.length !== 4 ||
            !managerReport.customerActivity || !managerReport.customerPayments) {
            throw new Error(`Manager revenue report failed: ${managerReport.error || response.status}`);
        }

        const reusedCode = await fetch(`${baseUrl}/login/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: managerChallengeId, code: storedCode })
        });
        if (reusedCode.status !== 400) throw new Error('A consumed code was accepted a second time.');

        console.log('Passed: login email codes, bcrypt password migration, scoped customer API access, reset links, role-protected fleet API, manager JWT, and quarterly reports.');
    } finally {
        if (challengeIds.length) {
            await connection.execute(
                `DELETE FROM login_code_challenges WHERE challenge_id IN (${challengeIds.map(() => '?').join(',')})`,
                challengeIds
            );
        }
        if (resetToken) {
            await connection.execute(
                'DELETE FROM customer_password_resets WHERE token_hash = ?',
                [crypto.createHash('sha256').update(resetToken).digest('hex')]
            );
        }
        if (customerId) {
            await connection.execute(
                'UPDATE users SET password = ? WHERE id = ?',
                [await bcrypt.hash('Test123!', 12), customerId]
            );
        }
        if (createdUserId) await connection.execute('DELETE FROM users WHERE id = ?', [createdUserId]);
        await connection.end();
    }
}

testLoginCodes().catch(error => {
    console.error('Login-code integration test failed:', error.message);
    process.exitCode = 1;
}).finally(() => process.exit(process.exitCode || 0));

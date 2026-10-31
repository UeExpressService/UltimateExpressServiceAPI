// Isolated HTTP regression tests: no production database, account or session is used.
const assert = require('node:assert/strict');
const express = require('express');
const registerPartners = require('./partners');

async function fixture({ fields = [], failAlterOnce = false, concurrentWinner = false } = {}) {
    const columns = new Set(fields);
    const partners = [{ id: 1, company: 'Manually added partner', contact_person: 'Existing contact', created_at: '2026-10-01' }];
    const audit = [];
    let databaseCalls = 0, alterCalls = 0, nextId = 2;
    const dbp = { async query(sql, args = []) {
        databaseCalls++;
        if (sql.startsWith('SHOW COLUMNS')) return [[...columns].map(Field => ({ Field }))];
        if (sql.startsWith('ALTER TABLE')) {
            alterCalls++;
            if (failAlterOnce) {
                failAlterOnce = false;
                throw Object.assign(new Error('Test-only ALTER denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
            }
            const name = sql.match(/ADD COLUMN (\w+)/)[1];
            columns.add(name);
            for (const row of partners) if (!(name in row)) row[name] = null;
            if (concurrentWinner) throw Object.assign(new Error('Another instance added the column'), { code: 'ER_DUP_FIELDNAME' });
            return [{}];
        }
        if (sql.startsWith('INSERT INTO partners')) {
            assert.ok(columns.has('email') && columns.has('phone'), 'Contact columns must exist before INSERT');
            const [company, contact_person, email, phone, partnership_type, contract_duration, agreement_details] = args;
            const row = { id: nextId++, company, contact_person, email, phone, partnership_type, contract_duration, agreement_details, created_at: new Date().toISOString() };
            partners.push(row);
            return [{ insertId: row.id }];
        }
        if (sql.startsWith('SELECT * FROM partners WHERE id')) return [partners.filter(p => p.id === Number(args[0]))];
        if (sql.startsWith('SELECT * FROM partners ORDER')) return [[...partners].reverse()];
        if (sql.startsWith('DELETE FROM partners')) {
            const index = partners.findIndex(p => p.id === Number(args[0]));
            if (index === -1) return [{ affectedRows: 0 }];
            partners.splice(index, 1);
            return [{ affectedRows: 1 }];
        }
        throw new Error('Unexpected query: ' + sql);
    } };
    class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
    const app = express();
    app.use(express.json());
    registerPartners(app, {
        dbp, HttpError,
        cleanText: (value, max) => String(value ?? '').trim().slice(0, max),
        isValidEmail: email => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email),
        requireManager: (req, res, next) => {
            const role = req.get('X-Test-Role');
            if (!role) return res.status(401).json({ error: 'Sign in required' });
            if (role !== 'manager') return res.status(403).json({ error: 'Manager required' });
            next();
        },
        auditManagerAction: action => (req, res, next) => {
            res.once('finish', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) audit.push({ action, id: res.locals.auditEntityId || req.params.id });
            });
            next();
        },
        sendError: (res, error, fallback) => res.status(error.status || 500).json({ error: error.status ? error.message : fallback })
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/partners`;
    return {
        partners, audit, columns,
        counts: () => ({ databaseCalls, alterCalls }),
        request: (method, body, role = 'manager', suffix = '') => fetch(base + suffix, {
            method, headers: { ...(role ? { 'X-Test-Role': role } : {}), 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }),
        close: () => new Promise(resolve => server.close(resolve))
    };
}

async function main() {
    const f = await fixture();
    const data = { company: '  Demo Partner & Logistics  ', contact_person: 'Demo Contact', email: 'partner@example.invalid', phone: '+63 912 000 0000', partnership_type: 'Corporate' };
    try {
        for (const method of ['GET', 'POST', 'DELETE']) {
            const body = method === 'POST' ? data : undefined;
            assert.equal((await f.request(method, body, null, method === 'DELETE' ? '/1' : '')).status, 401);
            for (const role of ['customer', 'dispatcher', 'supervisor']) {
                assert.equal((await f.request(method, body, role, method === 'DELETE' ? '/1' : '')).status, 403);
            }
        }
        assert.equal(f.counts().databaseCalls, 0, 'Unauthorized requests must not access or migrate storage');
        assert.equal((await f.request('POST', { company: ' ' })).status, 400);
        assert.equal((await f.request('POST', { ...data, email: 'invalid' })).status, 400);
        assert.equal(f.counts().databaseCalls, 0, 'Invalid input must not change storage');
        const responses = await Promise.all([f.request('POST', data), f.request('POST', { company: 'No optional contact' })]);
        assert.deepEqual(responses.map(r => r.status), [201, 201]);
        const saved = await responses[0].json();
        assert.equal(saved.company, data.company.trim());
        assert.equal(saved.email, data.email);
        assert.equal(saved.phone, data.phone);
        assert.equal(f.counts().alterCalls, 2, 'Concurrent requests share one migration check');
        const reloaded = await (await f.request('GET')).json();
        assert.equal(reloaded.find(row => row.id === saved.id).email, data.email);
        assert.equal(reloaded.find(row => row.id === 1).company, 'Manually added partner');
        assert.equal(reloaded.find(row => row.id === 1).email, null);
        assert.equal(f.audit.find(row => row.action === 'partner.created').id, saved.id);
        assert.equal((await f.request('DELETE', undefined, 'manager', '/invalid')).status, 400);
        assert.equal((await f.request('DELETE', undefined, 'manager', '/999')).status, 404);
        assert.equal((await f.request('DELETE', undefined, 'manager', '/' + saved.id)).status, 200);
        assert.ok(f.partners.some(row => row.id === 1), 'Existing manual records survive normal CRUD');
    } finally { await f.close(); }
    for (const options of [{ fields: ['email', 'phone'] }, { fields: ['email'] }, { concurrentWinner: true }]) {
        const scenario = await fixture(options);
        try {
            assert.equal((await scenario.request('POST', data)).status, 201);
            assert.equal(scenario.counts().alterCalls, 2 - (options.fields || []).length);
        } finally { await scenario.close(); }
    }
    const retry = await fixture({ failAlterOnce: true });
    const originalError = console.error;
    try {
        console.error = () => {};
        const denied = await retry.request('POST', data);
        assert.equal(denied.status, 503);
        assert.match((await denied.json()).error, /Partner storage could not be updated/);
        assert.equal(retry.partners.length, 1, 'Failed schema update never inserts a partial record');
        assert.equal((await retry.request('POST', data)).status, 201, 'A transient failure can be retried');
    } finally { console.error = originalError; await retry.close(); }
    console.log('Partner HTTP tests passed: manager-only access, legacy/current/partial schemas, concurrent migrations, contact persistence, manual record preservation, validation, audit IDs, deletion, and retryable failures.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

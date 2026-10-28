// Isolated HTTP contract tests. No production database or email provider is used.
const assert = require('node:assert/strict');
const express = require('express');
const registerWaybills = require('./waybills');

async function main() {
    const files = [];
    const bookings = [{ id: 1, customer_id: 7 }, { id: 2, customer_id: 8 }];
    let nextId = 1;
    let databaseCalls = 0;
    const dbp = {
        async query(sql, args = []) {
            databaseCalls++;
            if (sql.startsWith('CREATE TABLE')) return [{}];
            if (sql.startsWith('SELECT id, customer_id')) return [bookings.filter(row => String(row.id) === String(args[0]))];
            if (sql.startsWith('SELECT COUNT')) return [[{ total: files.filter(file => String(file.service_request_id) === String(args[0])).length }]];
            if (sql.startsWith('INSERT INTO service_request_waybills')) {
                const [service_request_id, uploaded_by, filename, content_type, byte_size, content] = args;
                const file = { id: nextId++, service_request_id, uploaded_by, filename, content_type, byte_size, content, created_at: new Date().toISOString() };
                files.push(file);
                return [{ insertId: file.id }];
            }
            if (sql.includes('WHERE id = ? AND service_request_id = ?')) {
                return [files.filter(file => String(file.id) === String(args[0]) && String(file.service_request_id) === String(args[1]))];
            }
            if (sql.includes('FROM service_request_waybills WHERE service_request_id = ?')) {
                return [files.filter(file => String(file.service_request_id) === String(args[0])).map(({ content, uploaded_by, service_request_id, ...file }) => file)];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
    class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
    const app = express();
    app.use(express.json({ limit: '200kb' }));
    // Exercise role middleware boundaries without creating real user sessions.
    const requireRoles = (...roles) => (req, res, next) => {
        const role = req.get('X-Test-Role');
        if (!role) return res.status(401).json({ error: 'Sign in required' });
        if (!roles.includes(role)) return res.status(403).json({ error: 'Forbidden' });
        req.auth = { role, sub: req.get('X-Test-User') || '7' };
        next();
    };
    registerWaybills(app, {
        dbp, withTransaction: work => work(dbp), requireRoles, HttpError,
        rateLimit: () => (req, res, next) => next(),
        sendError: (res, error) => res.status(error.status || 500).json({ error: error.message })
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/service-requests`;
    const request = (path, role, options = {}) => fetch(`${base}${path}`, {
        ...options, headers: { ...(role ? { 'X-Test-Role': role } : {}), ...options.headers }
    });
    const pdf = Buffer.from('%PDF-1.4\nWaybill contract test\n%%EOF');
    const upload = (path, role, name = 'waybill.pdf', body = pdf) => request(path, role, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body
    });
    try {
        assert.equal((await request('/1/waybills')).status, 401);
        assert.equal((await upload('/1/waybills', 'customer')).status, 403);
        assert.equal(databaseCalls, 0, 'Unauthenticated and unauthorized uploads never reach the database');
        assert.equal((await request('/0/waybills', 'dispatcher')).status, 400);
        assert.equal((await request('/999/waybills', 'dispatcher')).status, 404);
        assert.equal((await request('/2/waybills', 'customer')).status, 404);
        assert.equal((await upload('/1/waybills', 'dispatcher', 'fake.pdf', Buffer.from('<html>fake PDF</html>'))).status, 400);
        assert.equal((await upload('/1/waybills', 'dispatcher', 'wrong.png')).status, 400);
        assert.equal((await upload('/1/waybills', 'dispatcher', 'empty.pdf', Buffer.alloc(0))).status, 400);
        assert.equal((await upload('/1/waybills', 'dispatcher', 'large.pdf', Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
        const created = await upload('/1/waybills', 'dispatcher', 'Waybill José.pdf');
        assert.equal(created.status, 201);
        const file = await created.json();
        assert.equal(file.content_type, 'application/pdf');
        const metadata = await request('/1/waybills', 'customer');
        assert.equal(metadata.status, 200);
        const listed = await metadata.json();
        assert.equal(listed.length, 1);
        assert.equal(listed[0].content, undefined, 'Listings do not expose binary contents');
        const viewed = await request(`/1/waybills/${file.id}`, 'customer');
        assert.equal(viewed.status, 200);
        assert.equal(viewed.headers.get('cache-control'), 'no-store');
        assert.match(viewed.headers.get('content-disposition'), /^inline;/);
        assert.match(viewed.headers.get('content-disposition'), /filename\*=UTF-8''Waybill%20Jos%C3%A9.pdf/);
        assert.deepEqual(Buffer.from(await viewed.arrayBuffer()), pdf);
        const downloaded = await request(`/1/waybills/${file.id}?download=1`, 'customer');
        assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
        assert.equal((await request(`/1/waybills/${file.id}`, 'customer', { headers: { 'X-Test-User': '8' } })).status, 404);
        assert.equal((await request(`/2/waybills/${file.id}`, 'dispatcher')).status, 404);
        assert.equal((await request(`/1/waybills/${file.id}`)).status, 401);
        const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
        const jpg = Buffer.from([255, 216, 255, 224, 0]);
        assert.equal((await upload('/1/waybills', 'dispatcher', 'scan.png', png)).status, 201);
        assert.equal((await upload('/1/waybills', 'dispatcher', 'scan.jpg', jpg)).status, 201);
        for (let index = 3; index < 10; index++) assert.equal((await upload('/1/waybills', 'dispatcher')).status, 201);
        assert.equal((await upload('/1/waybills', 'dispatcher')).status, 409);
        console.log('Waybill HTTP tests passed: roles, ownership, binary download, metadata, signatures, size, and booking limits.');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

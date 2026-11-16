const assert = require('node:assert/strict');

// Called only by the isolated MySQL/HTTP test harness.
module.exports = async function testOperations(connection, base, tokens) {
    async function call(role, route, method = 'GET', body) {
        const response = await fetch(base + route, { method, headers: {
            Authorization: `Bearer ${tokens[role]}`, ...(body ? { 'Content-Type': 'application/json' } : {})
        }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        return { status: response.status, data };
    }
    await connection.query("INSERT INTO drivers (id,name,license_number,status) VALUES (101,'Isolated driver','ISOLATED-101','available')");
    await connection.query(`INSERT INTO trucks (id,type,license_plate,daily_rate,status,capacity,notes) VALUES
        (101,'4-Wheeler L300','ISOLATED-101',1234,'available','1000','PRIVATE FLEET NOTE'),
        (102,'4-Wheeler L300','DEMO-102',0,'available','1000','Demo'),
        (103,'4-Wheeler L300','TEST-103',0,'available','1000','Test')`);
    let result = await call('customer', '/customer/fleet');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.categories.map(item => item.amount), [5000, 12000, 20000, 18000, 30000]);
    assert.equal(result.data.categories[0].available, 1, 'Demo/test units excluded');
    assert.ok(!JSON.stringify(result.data).includes('PRIVATE') && !JSON.stringify(result.data).includes('ISOLATED-101'), 'Customer projection hides fleet records');
    assert.equal((await call('customer', '/driver-shifts')).status, 403);
    assert.equal((await call('dispatcher', '/drivers/101/time-in', 'POST')).status, 403);
    assert.equal((await call('customer', '/drivers/101/time-out', 'POST')).status, 403);
    assert.equal((await call('supervisor', '/driver-shifts?date=2026-02-30')).status, 400);
    assert.equal((await call('supervisor', '/drivers/9999/time-in', 'POST')).status, 404);
    const concurrent = await Promise.all([call('supervisor', '/drivers/101/time-in', 'POST'), call('supervisor', '/drivers/101/time-in', 'POST')]);
    assert.deepEqual(concurrent.map(item => item.status).sort(), [201, 409], 'Only one concurrent time in succeeds');
    result = await call('supervisor', '/driver-shifts');
    assert.ok(result.data.rows.find(row => row.driver_id === 101).open_id);
    assert.equal((await call('supervisor', '/drivers/101/time-out', 'POST')).status, 200);
    assert.equal((await call('supervisor', '/drivers/101/time-out', 'POST')).status, 409);
    assert.equal((await call('supervisor', '/drivers/101/time-in', 'POST')).status, 409);
    await connection.query('UPDATE driver_shifts SET work_date=DATE_SUB(work_date, INTERVAL 1 DAY),time_out=NULL WHERE driver_id=101');
    assert.equal((await call('supervisor', '/drivers/101/time-in', 'POST')).status, 409, 'Overnight shift must close first');
    assert.equal((await call('supervisor', '/drivers/101/time-out', 'POST')).status, 200);
    assert.equal((await call('supervisor', '/drivers/101/time-in', 'POST')).status, 201, 'Today can start after closing yesterday');
    const [[driver]] = await connection.query('SELECT status FROM drivers WHERE id=101');
    assert.equal(driver.status, 'available', 'Attendance does not reserve or release a driver');
    await connection.query(`INSERT INTO service_requests (id,customer_id,cargo_type,pickup_location,delivery_location,pickup_date,status,assigned_driver_id,assigned_truck_id,quoted_amount)
        VALUES (101,3,'Isolated cargo','Pickup','Delivery',CURDATE(),'pending',101,101,5000)`);
    const route = '/service-requests/101/supervisor-review';
    assert.equal((await call('customer', route)).status, 403);
    assert.equal((await call('supervisor', route, 'POST')).status, 403);
    assert.equal((await call('dispatcher', route, 'POST')).status, 409);
    await connection.query("UPDATE service_requests SET status='approved',assigned_truck_id=NULL WHERE id=101");
    assert.equal((await call('dispatcher', route, 'POST')).status, 409);
    await connection.query('UPDATE service_requests SET assigned_truck_id=101 WHERE id=101');
    assert.equal((await call('dispatcher', route, 'POST')).data.state, 'awaiting_review');
    await connection.query("UPDATE supervisor_booking_reviews SET sent_at='2026-01-01 12:00:00' WHERE service_request_id=101");
    assert.equal((await call('dispatcher', route, 'POST')).status, 200);
    const [[same]] = await connection.query("SELECT DATE_FORMAT(sent_at,'%Y-%m-%d %H:%i:%s') AS sent_at FROM supervisor_booking_reviews WHERE service_request_id=101");
    assert.equal(same.sent_at, '2026-01-01 12:00:00', 'Repeat send is idempotent');
    let queue = (await call('supervisor', '/supervisor/confirmed-bookings')).data;
    let item = queue.find(row => row.id === 101);
    assert.equal(item.state, 'awaiting_review');
    assert.equal((await call('dispatcher', route, 'PUT', { version: item.version, notes: '' })).status, 403);
    assert.equal((await call('supervisor', route, 'PUT', { version: item.version, notes: 'Checked' })).status, 200);
    assert.equal((await call('dispatcher', route)).data.state, 'reviewed');
    await connection.query("UPDATE service_requests SET status='ongoing' WHERE id=101");
    assert.equal((await call('dispatcher', route)).data.state, 'reviewed', 'Normal trip progression keeps the review');
    await connection.query("UPDATE service_requests SET cargo_type='Updated cargo' WHERE id=101");
    assert.equal((await call('dispatcher', route)).data.state, 'changed');
    assert.equal((await call('supervisor', route, 'PUT', { version: item.version, notes: '' })).status, 409);
    assert.equal((await call('dispatcher', route, 'POST')).data.state, 'awaiting_review');
    item = (await call('supervisor', '/supervisor/confirmed-bookings')).data.find(row => row.id === 101);
    assert.equal((await call('supervisor', route, 'PUT', { version: item.version, notes: '<script>stored as plain text</script>' })).status, 200);
    // A second unreviewed confirmed booking can still proceed through the existing dispatch route.
    await connection.query("INSERT INTO service_requests (id,customer_id,status,assigned_driver_id,assigned_truck_id,quoted_amount) VALUES (102,3,'approved',101,101,5000)");
    result = await call('dispatcher', '/service-requests/102', 'PUT', { status: 'ongoing', assigned_driver_id: 101, assigned_truck_id: 101, quoted_amount: 5000 });
    assert.equal(result.status, 200, 'Supervisor review does not gate dispatch');
    const rateUpdate = { type: '4-Wheeler L300', license_plate: 'ISOLATED-101', status: 'available' };
    assert.equal((await call('supervisor', '/trucks/101', 'PUT', rateUpdate)).status, 200);
    const [[truck]] = await connection.query('SELECT daily_rate FROM trucks WHERE id=101');
    assert.equal(Number(truck.daily_rate), 1234, 'Editing without a rate preserves the stored rate');
    assert.equal((await call('supervisor', '/trucks/101', 'PUT', { ...rateUpdate, daily_rate: -10 })).status, 400);
    for (let attempt=0; attempt<30; attempt++) {
        const [[count]]=await connection.query("SELECT COUNT(*) AS total FROM manager_audit_logs WHERE action='booking_review.reviewed' AND outcome='success'");
        if (count.total>=2) break;
        await new Promise(resolve=>setTimeout(resolve,20));
    }
    const [events]=await connection.query("SELECT action,actor_role,outcome FROM manager_audit_logs WHERE entity_type IN ('driver_shift','service_request')");
    assert.ok(events.some(event=>event.action==='attendance.time_in' && event.actor_role==='supervisor' && event.outcome==='success'));
    assert.ok(events.some(event=>event.action==='attendance.time_in' && event.actor_role==='dispatcher' && event.outcome==='denied'));
    assert.ok(events.some(event=>event.action==='booking_review.reviewed' && event.actor_role==='supervisor' && event.outcome==='success'));
    console.log('Operations MySQL/HTTP tests passed: private fleet projection, published prices, permissions, concurrent/overnight daily shifts, handoff and stale-review checks, dispatch continuity, rate preservation.');
};

// Uses the isolated database and captured mail from the main test harness.
const assert = require('node:assert/strict');
module.exports = async function testManualAssignment({ connection, base, sessions }) {
    const call = (role,method,path,body) => fetch(base+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessions[role]},...(body?{body:JSON.stringify(body)}:{})});
    const [{insertId:driverId}] = await connection.query("INSERT INTO drivers(name,license_number,phone,status) VALUES ('Assignment Test Driver','TEST-ASSIGN-001','09170000001','available')");
    const [{insertId:truckId}] = await connection.query("INSERT INTO trucks(type,license_plate,status) VALUES ('4-Wheeler L300','TEST-ASSIGN-001','available')");
    const details = {customer_id:3,contact_person:'Assignment Test Customer',contact_email:'assignment@example.invalid',pickup_location:'Test pickup',delivery_location:'Test destination',quoted_amount:7650,driver_id:driverId,truck_id:truckId,truck_type:'Incorrect client truck type'};
    const before = async () => (await connection.query('SELECT COUNT(*) AS n FROM service_requests'))[0][0].n;
    const count = await before();
    for (const invalid of [{driver_id:driverId,truck_id:null},{driver_id:0},{driver_id:999999},{truck_id:999999}]) {
        assert.equal((await call('dispatcher','POST','/service-requests',{...details,...invalid})).status,400);
    }
    assert.equal((await call('customer','POST','/service-requests',{...details,terms_accepted:true})).status,403);
    await connection.query("UPDATE trucks SET status='maintenance' WHERE id=?",[truckId]);
    assert.equal((await call('dispatcher','POST','/service-requests',details)).status,409);
    await connection.query("UPDATE trucks SET status='available' WHERE id=?",[truckId]);
    assert.equal(await before(),count,'Rejected assignments must not create a partial booking');
    const create = async () => { const response = await call('dispatcher','POST','/service-requests',details); assert.equal(response.status,201); return (await response.json()).id; };
    const first = await create(), second = await create();
    const [[saved]] = await connection.query('SELECT status,assigned_driver_id,assigned_truck_id,truck_type,quoted_amount,paid_amount FROM service_requests WHERE id=?',[first]);
    assert.equal(saved.status,'pending'); assert.equal(saved.assigned_driver_id,driverId); assert.equal(saved.assigned_truck_id,truckId);
    assert.equal(saved.truck_type,'4-Wheeler L300'); assert.equal(Number(saved.quoted_amount),7650); assert.equal(saved.paid_amount,null);
    for (const role of ['manager','supervisor','customer']) {
        const response = await call(role,'GET','/service-requests'); assert.equal(response.status,200);
        const row = (await response.json()).find(row=>row.id===first);
        assert.equal(row.assigned_driver_name,'Assignment Test Driver'); assert.equal(row.assigned_truck_plate,'TEST-ASSIGN-001');
    }
    const driverStatus = async () => (await connection.query('SELECT status FROM drivers WHERE id=?',[driverId]))[0][0].status;
    assert.equal(await driverStatus(),'available','Planned assignments do not start a trip');
    assert.equal((await call('dispatcher','PUT',`/service-requests/${first}`,{status:'approved'})).status,200);
    assert.equal(await driverStatus(),'busy');
    const supervisorFleet = await (await call('supervisor','GET','/trucks')).json();
    assert.equal(supervisorFleet.find(row=>row.id===truckId).status,'busy');
    assert.equal((await call('dispatcher','PUT',`/service-requests/${second}`,{status:'approved'})).status,409,'Another active trip cannot use the same resources');
    assert.equal((await call('dispatcher','POST',`/service-requests/${first}/supervisor-review`,{})).status,200);
    const reviews = await (await call('supervisor','GET','/supervisor/confirmed-bookings')).json();
    assert.equal(reviews.find(row=>row.id===first).driver_name,'Assignment Test Driver');
    assert.equal(reviews.find(row=>row.id===first).license_plate,'TEST-ASSIGN-001');
    assert.equal((await call('dispatcher','PUT',`/service-requests/${first}/cancel`,{})).status,200);
    assert.equal(await driverStatus(),'available');
    assert.equal((await call('dispatcher','PUT',`/service-requests/${second}/cancel`,{})).status,200);
    console.log('Manual assignments passed: atomic validation; pending plans; saved quote and canonical truck type; Manager, Customer and Supervisor visibility; active resource conflicts; Supervisor handoff; cancellation release.');
};

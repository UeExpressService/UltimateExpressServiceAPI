const assert = require('node:assert/strict');
module.exports = async function testManagerFeatures(db,base,tokens,{ originalHash, login }) {
    const call=async(role,path,method='GET',body,token=tokens[role])=>{
        const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        return {status:response.status,data:await response.json()};
    };
    await db.query("INSERT INTO users (id,name,email,password,role,verified,must_change_password) VALUES (6,'Role test','role6@example.invalid',?,'customer',1,0),(7,'Other manager','role7@example.invalid',?,'manager',1,0)",[originalHash,originalHash]);
    const fields={name:'Role test',email:'role6@example.invalid',phone:'',company:'',role:'manager'};
    for(const role of ['customer','dispatcher','supervisor'])assert.equal((await call(role,'/users/6','PUT',fields)).status,403);
    assert.equal((await call('manager','/users/6','PUT',{...fields,role:'administrator'})).status,400);
    for(const role of ['dispatcher','supervisor','customer']) {
        assert.equal((await call('manager','/users/6','PUT',{...fields,role})).status,200);
        const [[stored]]=await db.query('SELECT role FROM users WHERE id=6');assert.equal(stored.role,role);
    }
    assert.equal((await call('manager','/users/6','PUT',fields)).status,200);
    const manager6=await login('role6@example.invalid');
    assert.equal((await call('manager','/users','GET',null,manager6)).status,200,'Granted manager can use the Manager API after real sign-in');
    assert.equal((await call('manager','/users/6','PUT',{...fields,role:'dispatcher'})).status,200);
    assert.equal((await call('manager','/users','GET',null,manager6)).status,401,'Previous manager token loses access');
    assert.equal((await call('manager','/users/6','PUT',fields)).status,200);
    assert.equal((await call('manager','/users','GET',null,manager6)).status,401,'Changing a role back does not revive old tokens');
    const manager6fresh=await login('role6@example.invalid'), manager7=await login('role7@example.invalid');
    const self=await call('manager','/users/2','PUT',{name:'Reset test manager 2',email:'manager2@example.invalid',role:'customer'});
    assert.equal(self.status,409,'Cannot remove own manager access');
    const concurrent=await Promise.all([
        call('manager','/users/7','PUT',{name:'Other manager',email:'role7@example.invalid',role:'customer'},manager6fresh),
        call('manager','/users/6','PUT',{...fields,role:'customer'},manager7)
    ]);
    assert.equal(concurrent.filter(result=>result.status===200).length,1,'Only one simultaneous cross-demotion succeeds');
    assert.ok(concurrent.some(result=>[401,403].includes(result.status)));
    const [[managerCount]]=await db.query("SELECT COUNT(*) AS total FROM users WHERE role='manager'");
    assert.ok(managerCount.total>=2);
    const [[samePassword]]=await db.query('SELECT password FROM users WHERE id=6');
    assert.equal(samePassword.password,originalHash,'Role changes do not change passwords');
    // Partner edits update contacts and retain optional agreement fields if omitted.
    await db.query("INSERT INTO partners (id,company,contact_person,contract_duration,agreement_details) VALUES (201,'Old partner','Old contact','12 months','Keep this agreement')");
    assert.equal((await call('manager','/partners/201','PUT',{company:'Updated partner',email:'partner@example.invalid',phone:'123'})).status,200);
    const [[partner]]=await db.query('SELECT * FROM partners WHERE id=201');
    assert.equal(partner.company,'Updated partner');assert.equal(partner.contract_duration,'12 months');assert.equal(partner.agreement_details,'Keep this agreement');
    assert.equal((await call('dispatcher','/partners/201','PUT',{company:'Forbidden'})).status,403);
    assert.equal((await call('manager','/partners/201','PUT',{company:'Updated partner',email:'bad'})).status,400);
    assert.equal((await call('manager','/partners/9999','PUT',{company:'Missing'})).status,404);
    await db.query("INSERT INTO service_requests (id,customer_id,status,quoted_amount) VALUES (201,3,'approved',2500),(202,3,'pending',NULL)");
    const route='/service-requests/201/payment-schedule';
    for(const role of ['customer','supervisor'])assert.equal((await call(role,'/payment-schedules')).status,403);
    assert.equal((await call('manager',route,'PUT',{due_date:'2026-11-17',notes:''})).status,403);
    const initial=await call('dispatcher',route);assert.equal(initial.status,200);assert.equal(initial.data.payment_status,'not_scheduled');
    const today=initial.data.today;
    assert.equal((await call('dispatcher',route,'PUT',{due_date:'2026-02-30',notes:''})).status,400);
    assert.equal((await call('dispatcher','/service-requests/202/payment-schedule','PUT',{due_date:today,notes:''})).status,409);
    assert.equal((await call('dispatcher',route,'PUT',{due_date:today,notes:'Agreed date'})).status,200);
    assert.equal((await call('manager',route)).data.payment_status,'due_today');
    const yesterday=new Date(Date.parse(today)-86400000).toISOString().slice(0,10),tomorrow=new Date(Date.parse(today)+86400000).toISOString().slice(0,10);
    await call('dispatcher',route,'PUT',{due_date:yesterday,notes:'Overdue test'});
    assert.equal((await call('manager',route)).data.payment_status,'overdue');
    await call('dispatcher',route,'PUT',{due_date:tomorrow,notes:'Updated date'});
    assert.equal((await call('manager',route)).data.payment_status,'upcoming');
    const [[beforePayment]]=await db.query('SELECT paid_amount FROM service_requests WHERE id=201');
    assert.equal(beforePayment.paid_amount,null,'Scheduling does not record payment or revenue');
    await call('dispatcher',route,'PUT',{due_date:null,notes:''});
    assert.equal((await call('manager',route)).data.payment_status,'not_scheduled');
    await call('dispatcher',route,'PUT',{due_date:today,notes:''});
    assert.equal((await call('manager','/service-requests/201/payment','PUT',{paid_amount:2500})).status,200);
    assert.equal((await call('manager',route)).data.payment_status,'paid');
    assert.equal((await call('dispatcher',route,'PUT',{due_date:tomorrow,notes:''})).status,409);
    const list=await call('manager','/payment-schedules');assert.equal(list.status,200);assert.ok(list.data.some(row=>row.id===201&&row.payment_status==='paid'));
    console.log('Manager features MySQL/HTTP tests passed: all role grants, session revocation after reversal, self-access guard, concurrent role edits, preserved passwords, partner edits, schedule permissions, valid dates, payment states and no revenue from scheduling.');
};

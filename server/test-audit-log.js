const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const { createAuditTrail, routeActivity } = require('./audit-log');

async function fixture(t) {
    const rows=[], queries=[];
    const accounts=new Map([['1',{name:'Test Manager',email:'manager@example.invalid',role:'manager'}],['2',{name:'Test Customer',email:'customer@example.invalid',role:'customer'}],['3',{name:'Test Dispatcher',email:'dispatcher@example.invalid',role:'dispatcher'}],['4',{name:'Test Supervisor',email:'supervisor@example.invalid',role:'supervisor'}]]);
    const columns=['actor_name','actor_email','actor_role','outcome','http_status','source'];
    const dbp={async query(sql,values=[]){
        queries.push({sql,values});
        if(sql.includes('information_schema.COLUMNS'))return [columns.map(COLUMN_NAME=>({COLUMN_NAME}))];
        if(sql.startsWith('SELECT COUNT'))return [[{total:rows.length}]];
        if(sql.startsWith('SELECT log.id'))return [rows];
        return [[]];
    },async execute(sql,values){
        queries.push({sql,values});
        if(sql.startsWith('SELECT name'))return [[accounts.get(String(values[0]))].filter(Boolean)];
        if(sql.includes('INSERT INTO manager_audit_logs')){
            const keys=['actor_user_id','actor_name','actor_email','actor_role','action','entity_type','entity_id','summary','outcome','http_status','source'];
            rows.push(Object.fromEntries(keys.map((k,i)=>[k,values[i]])));return [{affectedRows:1}];
        }
        throw new Error('Unexpected audit write');
    }};
    let time=0;
    const audit=createAuditTrail({dbp,now:()=>time});
    const app=express();app.use(express.json());app.use('/api',audit.middleware);
    function requireRoles(...roles){return(req,res,next)=>{
        const id=req.get('x-test-user'),account=accounts.get(id);
        if(!account)return res.status(401).json({error:'Not authenticated'});
        req.auth={sub:id,role:account.role};
        if(!roles.includes(account.role))return res.status(403).json({error:'Not allowed'});
        next();
    };}
    const all=requireRoles('manager','dispatcher','supervisor','customer');
    audit.register(app,{requireRoles,requireManager:requireRoles('manager'),rateLimit:()=>((req,res,next)=>next())});
    app.get('/api/trucks',all,(req,res)=>res.json([]));
    app.post('/api/trucks',requireRoles('manager','supervisor'),(req,res)=>{res.locals.auditEntityId=99;res.status(201).json({id:99});});
    app.put('/api/trucks/:id',requireRoles('manager','supervisor'),(req,res)=>{if(req.body.invalid)return res.status(400).json({error:'Invalid truck'});res.json({ok:true});});
    app.post('/api/service-requests',requireRoles('customer','dispatcher'),(req,res)=>{res.locals.auditEntityId=55;res.status(201).json({id:55});});
    app.put('/api/service-requests/:id/payment',requireRoles('manager'),audit.describe('payment.recorded','service_request','Recorded a payment.'),(req,res)=>res.json({ok:true}));
    app.post('/api/login/verify-code',(req,res)=>{if(req.body.code!=='test-valid')return res.status(400).json({error:'Invalid code'});res.locals.auditActorUserId=2;res.json({id:2,authToken:'do-not-store-session-token'});});
    app.post('/api/logout',all,(req,res)=>res.status(204).end());
    app.get('/api/service-requests/:id/waybills/:waybillId',all,(req,res)=>res.send('test bytes'));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base='http://127.0.0.1:'+server.address().port;
    async function request(method,path,user,body){
        const response=await fetch(base+path,{method,headers:{...(user?{'x-test-user':String(user)}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        await response.text();await audit.flush();return response;
    }
    return {rows,queries,accounts,audit,request,tick:ms=>time+=ms};
}

test('records all four roles and always takes the actor from the validated session',async t=>{
    const f=await fixture(t);
    for(const id of [1,2,3,4])await f.request('GET','/api/trucks',id);
    assert.deepEqual(f.rows.map(r=>r.actor_role),['manager','customer','dispatcher','supervisor']);
    await f.request('POST','/api/service-requests',2,{actor_user_id:1,role:'manager',password:'never-store-password',code:'123456',token:'never-store-token'});
    const row=f.rows.at(-1);assert.equal(row.actor_user_id,2);assert.equal(row.entity_id,'55');assert.equal(row.action,'service_request.created');
    assert.ok(!JSON.stringify(f.rows).includes('never-store'));assert.ok(!JSON.stringify(f.rows).includes('123456'));
});
test('captures sign-in only after code verification and logs explicit sign-out',async t=>{
    const f=await fixture(t);
    await f.request('POST','/api/login/verify-code',null,{code:'incorrect',actor_user_id:1});assert.equal(f.rows.length,0);
    await f.request('POST','/api/login/verify-code',null,{code:'test-valid'});
    await f.request('POST','/api/logout',2);
    assert.deepEqual(f.rows.map(r=>r.action),['session.signed_in','session.signed_out']);
    assert.ok(!JSON.stringify(f.rows).includes('do-not-store-session-token'));
});
test('audits denied and invalid authenticated actions with their actual outcomes',async t=>{
    const f=await fixture(t);
    assert.equal((await f.request('POST','/api/trucks',2,{type:'example'})).status,403);
    await f.request('PUT','/api/trucks/99',4,{invalid:true});
    assert.equal(f.rows[0].outcome,'denied');assert.equal(f.rows[0].actor_role,'customer');assert.match(f.rows[0].summary,/Blocked attempt/);
    assert.equal(f.rows[1].outcome,'failed');assert.equal(f.rows[1].http_status,400);
});
test('collapses repeated read polling without collapsing writes, file access or later reads',async t=>{
    const f=await fixture(t);
    await f.request('GET','/api/trucks',4);await f.request('GET','/api/trucks',4);assert.equal(f.rows.length,1);
    await f.request('POST','/api/trucks',4,{});await f.request('POST','/api/trucks',4,{});assert.equal(f.rows.length,3);
    await f.request('GET','/api/service-requests/55/waybills/88',2);await f.request('GET','/api/service-requests/55/waybills/88',2);
    assert.equal(f.rows.length,5);assert.equal(f.rows[4].entity_id,'88');
    f.tick(300001);await f.request('GET','/api/trucks',4);assert.equal(f.rows.length,6);
});
test('legacy route annotations and the central hook produce one event, not two',async t=>{
    const f=await fixture(t);await f.request('PUT','/api/service-requests/55/payment',1,{paid_amount:100});
    assert.equal(f.rows.length,1);assert.equal(f.rows[0].action,'payment.recorded');
});
test('interface events use fixed names, preserve actor identity and cannot impersonate exports',async t=>{
    const f=await fixture(t);
    assert.equal((await f.request('POST','/api/activity',2,{action:'page.opened',page:'customer',actor_user_id:1,summary:'forged administrator action'})).status,204);
    assert.equal(f.rows[0].source,'interface');assert.equal(f.rows[0].actor_user_id,2);assert.ok(!f.rows[0].summary.includes('forged'));
    for(const body of [{action:'page.opened',page:'manager'},{action:'toString',page:'customer'},{action:'__proto__',page:'customer'},{action:'page.opened',page:'customer',section:'private-token-value'}])assert.equal((await f.request('POST','/api/activity',2,body)).status,400);
    assert.equal((await f.request('POST','/api/activity',2,{action:'report.export_requested',page:'customer'})).status,403);
    assert.equal(f.rows.length,1);
});
test('preserves actor snapshots after the user account is removed',async t=>{
    const f=await fixture(t);await f.request('POST','/api/service-requests',2,{});f.accounts.delete('2');
    assert.equal(f.rows[0].actor_name,'Test Customer');assert.equal(f.rows[0].actor_email,'customer@example.invalid');assert.equal(f.rows[0].actor_role,'customer');
});
test('only managers read the log; filtering is bound and pagination stays compatible',async t=>{
    const f=await fixture(t);assert.equal((await f.request('GET','/api/manager/audit-logs',2)).status,403);
    assert.equal(f.rows[0].action,'audit.access_denied');
    const search="%' OR 1=1 --";
    const response=await f.request('GET','/api/manager/audit-logs?role=customer&outcome=denied&source=server&limit=50&page=3&search='+encodeURIComponent(search),1);
    assert.equal(response.status,200);assert.equal(response.headers.get('X-Total-Count'),'1');assert.equal(f.rows.length,1);
    const query=f.queries.findLast(q=>q.sql.startsWith('SELECT log.id'));
    assert.ok(!query.sql.includes(search));assert.ok(query.values.includes('%'+search+'%'));assert.deepEqual(query.values.slice(-2),[50,100]);
});
test('every website business route has an audit descriptor or an explicit identity exception',()=>{
    const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
    const exceptions=new Set(['/api/register','/api/customer/password-reset/request']);
    for(const match of source.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)){
        const [,method,path]=match;if(!path.startsWith('/api/')||exceptions.has(path))continue;
        assert.ok(routeActivity({method:method.toUpperCase(),route:{path}}),method+' '+path);
    }
});

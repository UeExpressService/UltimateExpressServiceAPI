// Runs against the temporary MySQL instance owned by test-password-resets.js.
const assert = require('node:assert/strict');
module.exports = async function testPanelRevisions({ connection, base, sessions, post }) {
    const request = (role,method,path,body) => fetch(base+path,{method,headers:{'Content-Type':'application/json',...(sessions[role]?{Authorization:`Bearer ${sessions[role]}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const [[before]] = await connection.query('SELECT COUNT(*) AS total FROM users');
    // These columns are removed only from the fresh temporary test database, to exercise legacy recovery.
    await connection.query('ALTER TABLE customer_account_requests DROP COLUMN followup_notes,DROP COLUMN contacted_at,DROP COLUMN updated_by,DROP COLUMN updated_at');
    const response = await post('/customer-account-requests',{name:'Guest <script>no execution</script>',email:'guest@example.invalid',phone:'09170000000',company:'Guest Company',message:'Panel demo guest shipment inquiry'});
    assert.equal(response.status,201); const inquiry = await response.json();
    const [[after]] = await connection.query('SELECT COUNT(*) AS total FROM users');
    assert.equal(before.total,after.total,'Guest submission must not create an account');
    for (const role of ['anonymous','customer','supervisor']) assert.equal((await request(role,'GET','/website-inquiries')).status,role==='anonymous'?401:403);
    assert.equal((await connection.query("SHOW COLUMNS FROM customer_account_requests LIKE 'followup_notes'"))[0].length,0,'Unauthorized requests must not alter storage');
    for (const role of ['dispatcher','manager']) {
        const response = await request(role,'GET','/website-inquiries'); assert.equal(response.status,200);
        const list = await response.json(); assert.ok(list.some(row => row.id===inquiry.id && row.email==='guest@example.invalid'));
    }
    assert.equal((await request('dispatcher','PUT','/website-inquiries/'+inquiry.id,{status:'contacted',notes:'Called guest; quotation to follow.'})).status,200);
    const [[saved]] = await connection.query('SELECT status,contacted_at,followup_notes FROM customer_account_requests WHERE id=?',[inquiry.id]);
    assert.equal(saved.status,'contacted'); assert.ok(saved.contacted_at); assert.equal(saved.followup_notes,'Called guest; quotation to follow.');
    assert.equal((await request('customer','PUT','/website-inquiries/'+inquiry.id,{status:'processed',notes:''})).status,403);
    assert.equal((await request('dispatcher','PUT','/website-inquiries/'+inquiry.id,{status:'invalid',notes:''})).status,400);
    const created = await request('manager','POST','/users/create-customer',{requestId:inquiry.id});
    assert.equal(created.status,201,'Contacted inquiries must still support manager account creation');
    const createdData = await created.json(); assert.ok(createdData.user.id); assert.equal(createdData.emailSent,true);
    assert.ok(!JSON.stringify(createdData).includes('password'));
    assert.equal((await request('manager','POST','/users/create-customer',{requestId:inquiry.id})).status,409);

    for (const role of ['anonymous','customer','supervisor']) assert.equal((await request(role,'GET','/route-rates')).status,role==='anonymous'?401:403);
    const tariff = {label:'Company test route · truck',base_fare:1000,included_km:10,per_km:30,max_km:1000,notes:'Test-only approved tariff',active:true};
    assert.equal((await request('dispatcher','POST','/route-rates',tariff)).status,403);
    const rateResponse = await request('manager','POST','/route-rates',tariff); assert.equal(rateResponse.status,201);
    const rate = await rateResponse.json();
    const estimated = await request('dispatcher','POST','/route-estimates',{rate_id:String(rate.id),distance_km:100,extras:200});
    assert.equal(estimated.status,200); assert.equal((await estimated.json()).total,3900);
    const market = await request('dispatcher','POST','/route-estimates',{rate_id:'market-3t',distance_km:20,extras:0});
    assert.equal(market.status,200); const marketData = await market.json(); assert.equal(marketData.total,2110); assert.equal(marketData.market_reference,true); assert.ok(marketData.source_url.startsWith('https://www.lalamove.com/'));
    assert.equal((await request('dispatcher','POST','/route-estimates',{rate_id:'market-3t',distance_km:51,extras:0})).status,400);
    assert.equal((await request('dispatcher','POST','/route-estimates',{rate_id:String(rate.id),distance_km:100,extras:-1})).status,400);
    assert.equal((await request('manager','PUT','/route-rates/'+rate.id,{...tariff,active:false})).status,200);
    assert.equal((await request('dispatcher','POST','/route-estimates',{rate_id:String(rate.id),distance_km:100,extras:0})).status,404);

    const [{insertId:truckId}] = await connection.query("INSERT INTO trucks (type,license_plate,status) VALUES ('6-Wheeler Closed Van','TEST-PANEL-1','available')");
    for (const role of ['anonymous','customer','dispatcher']) assert.equal((await request(role,'GET','/truck-maintenance')).status,role==='anonymous'?401:403);
    const initial = await (await request('supervisor','GET','/truck-maintenance')).json();
    assert.equal(initial.rows.find(row=>row.id===truckId).oil_state,'baseline_required');
    const legacy=initial.rows.find(row=>row.license_plate==='TEST-MAINT-LEGACY');
    assert.equal(Number(legacy.odometer),4321,'Adding monitoring columns must preserve existing oil records');
    assert.equal(legacy.battery_state,'not_recorded'); assert.equal(legacy.fuel_filter_state,'not_recorded');
    const dayOffset=days=>new Date(Date.parse(initial.today)+days*86400000).toISOString().slice(0,10);
    const maintenance = {odometer:10000,oil_interval_km:5000,oil_interval_months:3,last_oil_km:5000,last_oil_date:initial.today,
        engine_number:'TEST-ENGINE',oil_filter:'TEST-FILTER',oil_liters:9,tire_size:'700-16',tire_unit:'32nds_inch',tire_readings:{front_right:2,front_left:10},tire_checked_at:initial.today,notes:'Test maintenance',version:null};
    const components={vehicle_model:'2020',battery_serial:'BATTERY-1 / BATTERY-2',battery_installed_at:dayOffset(-365),battery_due_date:dayOffset(-1),battery_notes:'Check battery terminals',fuel_filter_model:'FILTER-123',fuel_filter_installed_at:dayOffset(-30),fuel_filter_due_date:dayOffset(7),fuel_filter_notes:'Inspect at next service'};
    assert.equal((await request('supervisor','PUT',`/trucks/${truckId}/maintenance`,{...maintenance,...components})).status,200);
    const recorded = await (await request('manager','GET','/truck-maintenance')).json();
    const row = recorded.rows.find(row=>row.id===truckId);
    assert.equal(row.oil_state,'due'); assert.equal(row.tire_state,'danger'); assert.equal(row.next_oil_km,10000);
    assert.equal(row.battery_state,'overdue'); assert.equal(row.fuel_filter_state,'due_soon');
    assert.equal(row.battery_serial,components.battery_serial); assert.equal(row.vehicle_model,'2020');
    const [[truck]] = await connection.query('SELECT status FROM trucks WHERE id=?',[truckId]); assert.equal(truck.status,'available','Reminders must not silently alter dispatch status');
    assert.equal((await request('supervisor','PUT',`/trucks/${truckId}/maintenance`,{...maintenance,version:0,odometer:9999})).status,409);
    assert.equal((await request('supervisor','PUT',`/trucks/${truckId}/maintenance`,maintenance)).status,409,'Stale edits cannot overwrite a newer record');
    assert.equal((await request('manager','PUT',`/trucks/${truckId}/maintenance`,{...maintenance,version:0,odometer:11000,last_oil_km:11000})).status,200);
    const afterOldClient=(await (await request('manager','GET','/truck-maintenance')).json()).rows.find(row=>row.id===truckId);
    assert.equal(afterOldClient.battery_serial,components.battery_serial,'An older client must not erase battery fields');
    assert.equal(afterOldClient.fuel_filter_model,components.fuel_filter_model,'An older client must not erase fuel-filter fields');
    const history=await (await request('supervisor','GET',`/trucks/${truckId}/maintenance-history`)).json();
    assert.equal(history.length,2);
    const snapshot=typeof history[0].snapshot==='string'?JSON.parse(history[0].snapshot):history[0].snapshot;
    assert.equal(snapshot.battery_serial,components.battery_serial); assert.equal(snapshot.fuel_filter_due_date,components.fuel_filter_due_date);
    assert.equal((await request('manager','PUT',`/trucks/${truckId}/maintenance`,{...maintenance,version:1,last_oil_date:'2099-01-01'})).status,400);
    for(const invalid of [{battery_installed_at:dayOffset(1)},{battery_due_date:dayOffset(-366)},{fuel_filter_due_date:'2026-02-30'},{fuel_filter_notes:'x'.repeat(1001)}]) {
        assert.equal((await request('manager','PUT',`/trucks/${truckId}/maintenance`,{...maintenance,version:1,odometer:11000,...invalid})).status,400);
    }
    const [{insertId:componentTruck}]=await connection.query("INSERT INTO trucks (type,license_plate,status) VALUES ('Component-only truck','TEST-COMPONENT-ONLY','available')");
    assert.equal((await request('supervisor','PUT',`/trucks/${componentTruck}/maintenance`,{...maintenance,odometer:null,last_oil_km:null,last_oil_date:null,tire_readings:{},tire_checked_at:null,battery_serial:'Known battery, mileage unknown'})).status,200);
    const componentOnly=(await (await request('manager','GET','/truck-maintenance')).json()).rows.find(row=>row.id===componentTruck);
    assert.equal(componentOnly.odometer,null); assert.equal(componentOnly.oil_state,'baseline_required'); assert.equal(componentOnly.battery_state,'due_date_required');
    for (const script of ['website-inquiries.js','print-documents.js','route-pricing.js','maintenance.js']) {
        const response = await fetch(base.replace(/\/api$/,'/')+script); assert.equal(response.status,200,script+' must be publicly served');
    }
    console.log('Panel revisions passed: account-free guest inquiry; shared staff inbox; follow-up persistence and permissions; contacted inquiry account handoff; company and market estimates; maintenance due rules, history, stale-edit protection; new scripts served.');
    const [{insertId:receiptId}] = await connection.query(`INSERT INTO service_requests (customer_id,contact_person,contact_email,contact_phone,pickup_location,delivery_location,cargo_type,quoted_amount,paid_amount,paid_at,status)
        VALUES (3,'Receipt UI Customer','customer3@example.invalid','09170000002','Manila','Laguna','Test cargo',1500,1500,NOW(),'completed')`);
    return {truckId,inquiryId:inquiry.id,receiptId};
};

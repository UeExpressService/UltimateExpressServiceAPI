// Uses only the temporary MySQL database started by test-password-resets.js.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {period,loadReport}=require('./operational-reports');

module.exports=async function({connection,base,sessions,emails}){
    const emailCount=emails.length;
    const request=(role,type='bookings',query='from=2035-01-01&to=2035-01-31')=>fetch(`${base}/reports/${type}.pdf?${query}`,{
        headers:sessions[role]?{Authorization:'Bearer '+sessions[role], 'X-Forwarded-For':role==='manager'?'198.51.100.10':'198.51.100.11'}:{}
    });
    for(const [role,expected] of [['anonymous',401],['customer',403],['dispatcher',403]])assert.equal((await request(role)).status,expected);
    assert.equal((await request('supervisor','payments')).status,403);
    assert.equal((await request('manager','unknown')).status,404);
    for(const query of ['','from=2035-02-30&to=2035-03-01','from=2035-01-31&to=2035-01-01','from=2035-01-01&to=2036-01-02','from[]=2035-01-01&to=2035-01-31'])assert.equal((await request('manager','bookings',query)).status,400);
    const [{insertId:truck1}]=await connection.query("INSERT INTO trucks(type,license_plate,created_at)VALUES('Report Van','REPORT-1','2035-01-01 00:00:00')");
    const [{insertId:truck2}]=await connection.query("INSERT INTO trucks(type,license_plate,created_at)VALUES('Report Truck','REPORT-2','2035-01-31 23:59:59')");
    const [{insertId:driver1}]=await connection.query("INSERT INTO drivers(name,license_number,created_at)VALUES('Report Driver','REPORT-LIC-1','2035-01-01 00:00:00')");
    const [{insertId:driver2}]=await connection.query("INSERT INTO drivers(name,license_number,created_at)VALUES('Report Driver','REPORT-LIC-2','2035-01-31 23:59:59')");
    await connection.query("INSERT INTO drivers(name,license_number,created_at)VALUES('Unassigned New Driver','REPORT-UNUSED','2035-01-20'),('Prior Driver','REPORT-PRIOR','2034-12-31 23:59:59'),('Next Month Driver','REPORT-NEXT','2035-02-01 00:00:00')");
    await connection.query("INSERT INTO trucks(type,license_plate,created_at)VALUES('Unassigned New Truck','REPORT-UNUSED','2035-01-20'),('Prior Truck','REPORT-PRIOR','2034-12-31 23:59:59'),('Next Month Truck','REPORT-NEXT','2035-02-01 00:00:00')");
    const insert=async(status,pickup,created,driver,truck,quote=null,paid=null,paidAt=null)=>{
        const [{insertId}]=await connection.query(`INSERT INTO service_requests(customer_id,contact_person,pickup_location,delivery_location,status,pickup_date,created_at,assigned_driver_id,assigned_truck_id,quoted_amount,paid_amount,paid_at)
            VALUES(3,'Report Customer','Manila','Laguna',?,?,?,?,?,?,?,?)`,[status,pickup,created,driver,truck,quote,paid,paidAt]);return insertId;
    };
    const a=await insert('approved','2035-01-01','2034-12-15',driver1,truck1,2500);
    await insert('completed','2035-01-15','2035-01-01',driver1,truck1,1000,1000,'2035-02-01');
    await insert('ongoing','2035-01-31','2035-01-01',driver2,truck1,500);
    await insert('pending','2035-01-31','2035-01-01',driver1,truck2,800);
    await insert('cancelled','2035-01-02','2035-01-01',driver1,truck2,600);
    await insert('new','2035-01-03','2035-01-01',null,null);
    await insert('completed','2035-01-04','2035-01-01',null,null);
    const fallback=await insert('completed',null,'2035-01-31 23:59:59',driver2,truck2,500,500,'2035-01-31 23:59:59');
    await insert('legacy','2035-01-04','2035-01-01',null,null);
    const prior=await insert('completed','2034-12-31','2034-12-01',driver1,truck1,123.45,123.45,'2035-01-01 00:00:00');
    await insert('completed','2035-02-01','2035-01-01',driver1,truck1);
    await insert('completed',null,'2035-02-01 00:00:00',driver1,truck1);
    const data=await loadReport(connection,period({from:'2035-01-01',to:'2035-01-31'}),2,'payments');
    assert.equal(data.rows.length,9);assert.ok(data.rows.some(r=>r.id===a));assert.ok(data.rows.some(r=>r.id===fallback&&r.date_basis==='Created'));
    assert.ok(!data.rows.some(r=>r.id===prior));assert.equal(data.payments.length,2);
    assert.ok(data.payments.some(r=>r.id===prior),'January payment for December booking belongs in January payment register');
    assert.equal(data.summary.completionRate,33.33);assert.equal(data.summary.confirmed,5);assert.equal(data.summary.assignmentCoverage,80);
    assert.equal(data.summary.missingDriver,1);assert.equal(data.summary.missingTruck,1);
    assert.deepEqual(data.summary.trucks.map(r=>[r.name,r.assigned,r.completed]),[['REPORT-1',3,1],['REPORT-2',1,1]]);
    assert.equal(data.summary.drivers.length,2,'Same names with different IDs are not merged');
    assert.equal(data.payments.reduce((sum,r)=>sum+Math.round(Number(r.paid_amount)*100),0),62345);
    const empty=await loadReport(connection,period({from:'2036-01-01',to:'2036-01-31'}),2);
    assert.equal(empty.summary.total,0);assert.equal(empty.summary.completionRate,null);
    const fleet=await loadReport(connection,period({from:'2035-01-01',to:'2035-01-31'}),2,'fleet');
    assert.equal(fleet.newDrivers.length,3);assert.equal(fleet.newTrucks.length,3);
    assert.ok(fleet.newDrivers.some(r=>r.id===driver1&&r.added_date==='2035-01-01'));
    assert.ok(fleet.newDrivers.some(r=>r.id===driver2&&r.added_date==='2035-01-31'));
    assert.ok(fleet.newDrivers.some(r=>r.name==='Unassigned New Driver'),'New drivers without trips are included');
    assert.ok(fleet.newTrucks.some(r=>r.type==='Unassigned New Truck'),'New trucks without trips are included');
    assert.ok(!fleet.newDrivers.some(r=>['Prior Driver','Next Month Driver'].includes(r.name)));
    assert.ok(!fleet.newTrucks.some(r=>['REPORT-PRIOR','REPORT-NEXT'].includes(r.license_plate)));
    const emptyFleet=await loadReport(connection,period({from:'2036-01-01',to:'2036-01-31'}),2,'fleet');
    assert.deepEqual(emptyFleet.newDrivers,[]);assert.deepEqual(emptyFleet.newTrucks,[]);
    const driverList=await loadReport(connection,period({from:'2035-01-01',to:'2035-01-31'}),2,'driverlist');
    assert.ok(driverList.allDrivers.some(r=>r.name==='Prior Driver'),'Full driver list includes older records');
    assert.ok(driverList.allDrivers.some(r=>r.name==='Unassigned New Driver'),'Full driver list includes unused drivers');
    assert.ok(driverList.allDrivers.some(r=>r.id===driver2),'Last-day driver is included');
    assert.ok(!driverList.allDrivers.some(r=>r.name==='Next Month Driver'),'Full driver list excludes records after the selected end date');
    const truckList=await loadReport(connection,period({from:'2035-01-01',to:'2035-01-31'}),2,'trucklist');
    assert.ok(truckList.allTrucks.some(r=>r.license_plate==='REPORT-PRIOR'),'Full truck list includes older records');
    assert.ok(truckList.allTrucks.some(r=>r.license_plate==='REPORT-UNUSED'),'Full truck list includes unused trucks');
    assert.ok(truckList.allTrucks.some(r=>r.id===truck2),'Last-day truck is included');
    assert.ok(!truckList.allTrucks.some(r=>r.license_plate==='REPORT-NEXT'),'Full truck list excludes later registrations');
    const output=process.env.UE_REPORT_QA_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'ue-operational-reports-'));
    fs.mkdirSync(output,{recursive:true});
    for(const [role,type] of [['manager','payments'],['manager','bookings'],['supervisor','fleet'],['manager','driverlist'],['supervisor','trucklist'],['supervisor','drivers'],['manager','newdrivers'],['supervisor','newtrucks'],['supervisor','customertrucks']]){
        const response=await request(role,type);assert.equal(response.status,200);
        assert.match(response.headers.get('content-type'),/^application\/pdf/);
        assert.match(response.headers.get('content-disposition'),new RegExp(type+'-2035-01-01-to-2035-01-31.pdf'));
        assert.match(response.headers.get('cache-control'),/no-store/);
        const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
        fs.writeFileSync(path.join(output,type+'.pdf'),bytes);
    }
    fs.writeFileSync(path.join(output,'verified-summary.json'),JSON.stringify(data.summary,null,2));
    console.log('Operational reports passed: role restrictions, valid inclusive dates, full fleet registers including older and unused resources, end-date boundaries, monthly new driver/truck lists, fallback dates, payment-date cohort, pending/cancelled exclusions, missing assignments, repeated names, all nine PDF downloads and empty periods. Evidence: '+output);
    if(process.env.UE_REPORT_BROWSER_QA)await require('./test-operational-report-ui')({base,sessions,output});
    assert.equal(emails.length,emailCount,'Generating reports does not send any email');
    for(let attempt=0;attempt<30;attempt++){
        const [[count]]=await connection.query("SELECT COUNT(*) AS total FROM manager_audit_logs WHERE action='report.generated' AND outcome='success' AND summary LIKE '%2035-01-01 to 2035-01-31%'");
        if(count.total>=3)break;
        if(attempt===29)assert.fail('Successful report downloads must appear in the activity log with the reporting period');
        await new Promise(resolve=>setTimeout(resolve,25));
    }
};

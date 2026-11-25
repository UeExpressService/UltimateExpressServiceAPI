const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { period, summarize, statusGroup, renderPDF, TITLES } = require('./operational-reports');

test('report periods include leap days and reject rollover, reversed, excessive and non-scalar dates', () => {
    assert.equal(period({from:'2024-01-01',to:'2024-12-31'}).days,366);
    assert.equal(period({from:'2026-11-30',to:'2026-11-30'}).days,1);
    for (const dates of [
        {from:'2026-02-29',to:'2026-03-01'}, {from:'2026-01-31',to:'2026-01-01'},
        {from:'2026-01-01',to:'2027-01-02'}, {from:['2026-01-01'],to:'2026-02-01'},
        {from:'2026-1-01',to:'2026-02-01'}, {from:'2026-01-01',to:'invalid'}, {}
    ]) assert.throws(()=>period(dates),error=>error.status===400);
});

test('activity counts omit cancelled and pending assignments and preserve distinct resource IDs', () => {
    const statuses=['completed','approved','ongoing','pending','new','cancelled','legacy',null];
    const rows=statuses.map((status,i)=>({id:i+1,status,report_date:'2026-11-01',assigned_driver_id:i===2?2:1,
        driver_name:'Same name',assigned_truck_id:i===2?null:1,truck_plate:'TRK-1',truck_type:'Van'}));
    const s=summarize(rows);
    assert.deepEqual(s.counts,{Pending:3,Ongoing:2,Completed:1,Cancelled:1,Other:1});
    assert.equal(s.total,8); assert.equal(s.confirmed,3); assert.equal(s.completionRate,12.5);
    assert.equal(s.trucks[0].assigned,2); assert.equal(s.drivers.length,2);
    assert.equal(s.missingTruck,1); assert.equal(s.assignmentCoverage,66.67);
    assert.equal(s.monthly[0].total,8);
    assert.equal(statusGroup(' APPROVED '),'Ongoing');
    const empty=summarize([]);assert.equal(empty.completionRate,null);assert.equal(empty.assignmentCoverage,null);
});

test('empty report PDFs are valid standalone files for every report type', async () => {
    const report={period:period({from:'2026-11-01',to:'2026-11-30'}),rows:[],payments:[],summary:summarize([]),
        preparedBy:'Test Manager',role:'manager',generatedAt:new Date('2026-11-25T04:00:00Z')};
    for(const type of Object.keys(TITLES)){
        const pdf=await renderPDF(report,type);
        assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>3000);
        if(process.env.UE_REPORT_QA_DIR)fs.writeFileSync(path.join(process.env.UE_REPORT_QA_DIR,'empty-'+type+'.pdf'),pdf);
    }
});

test('long addresses and large registers render without losing rows', async () => {
    const rows=Array.from({length:35},(_,i)=>({id:1000+i,status:'completed',report_date:'2026-11-01',date_basis:'Pickup',
        customer_name:'A customer with a longer company name',pickup_location:'Manila, National Capital Region',delivery_location:'Laguna, Region IV-A',
        assigned_driver_id:1,assigned_truck_id:1,driver_name:'Test Driver',truck_plate:'TEST-TRK',truck_type:'Test Truck'}));
    rows[1].pickup_location='W'.repeat(500);rows[1].delivery_location='X'.repeat(500);rows[1].customer_name='Y'.repeat(255);
    const pdf=await renderPDF({period:period({from:'2026-11-01',to:'2026-11-30'}),rows,payments:[],summary:summarize(rows),
        preparedBy:'Z'.repeat(255),role:'manager',generatedAt:new Date()},'bookings');
    assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>10000);
    if(process.env.UE_REPORT_QA_DIR)fs.writeFileSync(path.join(process.env.UE_REPORT_QA_DIR,'long-register.pdf'),pdf);
});

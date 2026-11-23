const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculate,MARKET_RATES } = require('./route-pricing');
const { recommendations,addMonths,componentState } = require('./maintenance');
const {roundTripKm}=require('./trip-maintenance');

test('one-way map kilometers become round-trip kilometers at odometer precision',()=>{
    assert.equal(roundTripKm(10),20);
    assert.equal(roundTripKm(75.025),150.1);
    assert.equal(roundTripKm(0.05),0.1);
    const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
    const browser={window:{UE:{}}};vm.createContext(browser);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../Latest Update/route-map.js'),'utf8'),browser);
    for(const oneWay of [10,75.025,0.05,123.45])assert.equal(browser.window.UE.RouteMap.roundTripKm(oneWay),roundTripKm(oneWay));
    const map={_ueDistanceAddresses:{pickup:'A',delivery:'B'},_ueRoadDistanceKm:12.5};
    assert.equal(browser.window.UE.RouteMap.oneWayFor(map,'A','B'),12.5);
    assert.equal(browser.window.UE.RouteMap.oneWayFor(map,'A','Changed destination'),null);
});
test('tariff boundary, included distance, cents and unsupported ranges', () => {
    const rate = {base_fare:1000,included_km:10,per_km:30,max_km:500};
    assert.equal(calculate(rate,5,0).total,1000); assert.equal(calculate(rate,10,0).total,1000);
    assert.equal(calculate(rate,10.01,0).total,1000.30); assert.equal(calculate(rate,500,0).total,15700);
    for(const distance of [0,-1,501,Infinity,NaN,'10']) assert.equal(calculate(rate,distance,0),null);
    assert.equal(calculate(rate,20,-1),null); assert.equal(calculate(MARKET_RATES[0],51,0),null);
});
test('oil reminder works at mileage and calendar boundaries and clamps month ends', () => {
    assert.equal(addMonths('2026-01-31',3),'2026-04-30'); assert.equal(addMonths('2023-11-30',3),'2024-02-29');
    const row = {last_oil_km:1000,last_oil_date:'2026-08-18',odometer:1500,oil_interval_km:5000,oil_interval_months:3};
    assert.equal(recommendations(row,'2026-11-18').oil_state,'due');
    assert.equal(recommendations({...row,last_oil_date:'2026-11-01',odometer:6000},'2026-11-18').oil_state,'due');
    assert.equal(recommendations({...row,last_oil_km:null},'2026-11-18').oil_state,'baseline_required');
    assert.equal(recommendations({...row,last_oil_date:'2026-11-01',odometer:5500},'2026-11-18').oil_state,'due_soon');
});
test('tire sheet thresholds and both units; missing measurements are not clearance', () => {
    const run = (value,unit='32nds_inch') => recommendations({tire_unit:unit,tire_readings:{front_right:value}},'2026-11-18');
    assert.equal(run(2).tire_state,'danger'); assert.equal(run(4).tire_state,'replacement');
    assert.equal(run(5).tire_alerts[0].state,'good'); assert.equal(run(10).tire_alerts[0].state,'excellent');
    assert.equal(run(1.5875,'mm').tire_state,'danger'); assert.equal(run(3.175,'mm').tire_state,'replacement');
    assert.equal(recommendations({},'2026-11-18').tire_state,'not_recorded');
});
test('battery and fuel-filter reminders use only entered dates and flag the fourteen-day boundary', () => {
    const today='2026-11-18';
    assert.equal(componentState(null,null,'',today),'not_recorded');
    assert.equal(componentState(null,null,'Serial ABC',today),'due_date_required');
    assert.equal(componentState('2025-11-17','2026-11-17','',today),'overdue');
    assert.equal(componentState('2025-11-18','2026-11-18','',today),'due');
    assert.equal(componentState('2026-01-01','2026-12-02','',today),'due_soon');
    assert.equal(componentState('2026-01-01','2026-12-03','',today),'scheduled');
    const row=recommendations({battery_serial:'A/B',battery_installed_at:'2025-11-17',battery_due_date:'2026-11-17',fuel_filter_model:'Filter',fuel_filter_due_date:'2026-12-02'},today);
    assert.equal(row.battery_state,'overdue'); assert.equal(row.fuel_filter_state,'due_soon');
    assert.equal(row.oil_state,'baseline_required'); assert.equal(row.odometer,undefined);
});

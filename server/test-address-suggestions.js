const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'../Latest Update/Customer.html'),'utf8');

test('address suggestions follow region/province and editable postal codes survive copying', () => {
    const elements = {}, lists = {};
    for (const prefix of ['quotePickup','quoteDelivery']) for (const part of ['Region','Province','City','Barangay','Postal','House','Street']) {
        elements[prefix+part] = { value:'',dataset:{},error:'',setCustomValidity(value){this.error=value;} };
    }
    elements.sameAsPickupAddress = {checked:true};
    const context = vm.createContext({document:{getElementById:id=>elements[id]},setDatalistOptions:(id,values)=>{lists[id]=Array.from(values);}});
    const catalog = html.slice(html.indexOf('        const ADDRESS_CATALOG ='),html.indexOf('        function setDatalistOptions('));
    const update = html.slice(html.indexOf('        function updateAddressSuggestions('),html.indexOf('        function populateCustomerProfile('));
    const copy = html.slice(html.indexOf('        function copyPickupToDelivery('),html.indexOf('        function showSuccess('));
    vm.runInContext(catalog+update+copy,context);
    const run = script => vm.runInContext(script,context);
    elements.quotePickupRegion.value='Region III'; elements.quotePickupProvince.value='Metro Manila'; elements.quotePickupCity.value='Manila';
    run("updateAddressSuggestions('quotePickup','region')");
    assert.equal(elements.quotePickupCity.value,'');
    assert.deepEqual(lists.quotePickupCityList,['Angeles City','Malolos City']);
    elements.quotePickupCity.value='Malolos City';run("updateAddressSuggestions('quotePickup','city')");
    assert.equal(elements.quotePickupProvince.value,'Bulacan');assert.equal(elements.quotePickupPostal.value,'3000');
    elements.quotePickupPostal.value='3005';run('copyPickupToDelivery()');
    assert.equal(elements.quoteDeliveryPostal.value,'3005','A customer correction must not be overwritten by the suggested ZIP');
    elements.quotePickupStreet.value='Updated street';run('copyPickupToDelivery()');assert.equal(elements.quoteDeliveryPostal.value,'3005');
    elements.quotePickupRegion.value='NCR';run("updateAddressSuggestions('quotePickup','region')");
    assert.equal(elements.quotePickupPostal.value,'');assert.ok(lists.quotePickupCityList.includes('Manila'));assert.ok(!lists.quotePickupCityList.includes('Cebu City'));
    elements.quotePickupCity.value='Cebu City';run("updateAddressSuggestions('quotePickup','city')");assert.ok(elements.quotePickupCity.error);
    elements.quoteDeliveryRegion.value='Region IV-A';run("updateAddressSuggestions('quoteDelivery','region')");
    assert.ok(lists.quoteDeliveryCityList.includes('Bacoor City'));assert.ok(!lists.quoteDeliveryCityList.includes('Manila'));
    elements.quoteDeliveryProvince.value='Laguna';run("updateAddressSuggestions('quoteDelivery','province')");
    assert.deepEqual(lists.quoteDeliveryCityList,['Calamba City','Santa Rosa City']);
    for(const prefix of ['quotePickup','quoteDelivery']) {
        const tag = html.match(new RegExp('<input[^>]*id="'+prefix+'Postal"[^>]*>'))[0];assert.ok(!tag.includes('readonly'));assert.ok(tag.includes('maxlength="4"'));
    }
});

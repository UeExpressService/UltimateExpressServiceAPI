// Optional local browser QA. Invoked only by the isolated test database harness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async function revisionUI({ base,sessions,receiptId,uiTripTruckId,uiBookingId }) {
    const { chromium } = require(process.env.UE_PLAYWRIGHT_MODULE);
    const output = process.env.UE_UI_OUTPUT;
    fs.mkdirSync(output,{recursive:true});
    const browser = await chromium.launch({headless:true,...(process.env.UE_BROWSER_EXECUTABLE?{executablePath:process.env.UE_BROWSER_EXECUTABLE}:{})});
    const origin = base.replace(/\/api$/,'');
    const pages = [];
    async function pageFor(role,roadMap=false) {
        const context = await browser.newContext({viewport:{width:1440,height:1000}});
        await context.route('**/*',route => {
            const url = new URL(route.request().url());
            if(roadMap&&url.hostname==='nominatim.openstreetmap.org')return route.fulfill({json:[{lat:url.searchParams.get('q').includes('Manila')?'14.6':'14.2',lon:'121.0',display_name:url.searchParams.get('q')}]});
            if(roadMap&&url.hostname==='router.project-osrm.org')return route.fulfill({json:{code:'Ok',routes:[{distance:10000,geometry:{coordinates:[[121,14.6],[121,14.2]]}}]}});
            if (url.origin !== origin) return route.abort();
            // The isolated harness uses a random port, unlike the default localhost:3000 launcher.
            if (url.pathname === '/api-config.js') return route.fulfill({contentType:'text/javascript',body:`window.UE_API_URL=${JSON.stringify(base)};`});
            return route.continue();
        });
        await context.addInitScript(({role,token,roadMap}) => {
            window.Chart = class { constructor(element,config) { Object.assign(this,config); } update(){} destroy(){} };
            if(roadMap){
                const layer=()=>({addTo(){return this;},clearLayers(){},bindPopup(){return this;}});
                window.L={map:()=>({setView(){return this;},on(){},invalidateSize(){},fitBounds(){}}),tileLayer:layer,layerGroup:layer,marker:layer,polyline:layer,latLngBounds:points=>points};
            }
            if(token) sessionStorage.setItem('currentUser',JSON.stringify({id:{manager:2,dispatcher:4,supervisor:5}[role],role,name:'Local QA '+role,email:role+'@example.invalid',mfaAuthenticated:true,authToken:token,loginTime:new Date().toISOString()}));
        },{role,token:sessions[role],roadMap});
        const page = await context.newPage(); page.setDefaultTimeout(15000);
        const errors=[]; page.on('pageerror',error=>errors.push(error.message));
        pages.push({page,errors,role}); return page;
    }
    async function printPDF(page,name) {
        await page.evaluate(()=>document.body.classList.add('ue-document-printing'));
        await page.emulateMedia({media:'print'});
        await page.pdf({path:path.join(output,name+'.pdf'),preferCSSPageSize:true,printBackground:true});
        await page.emulateMedia({media:'screen'});
        await page.evaluate(()=>document.body.classList.remove('ue-document-printing'));
        await page.locator('#ueDocumentPreview [data-close]').click();
    }
    try {
        const landing=await pageFor('guest'); await landing.goto(origin+'/LandingPage.html');
        assert.equal(await landing.locator('#contactForm').count(),0,'Public inquiry form is replaced by the FAQ');
        assert.equal(await landing.locator('#faq details').count(),6);
        const faqRequests=[];
        landing.on('request',request=>{if(request.url().includes('/customer-account-requests'))faqRequests.push(request.url());});
        await landing.locator('#services .service-link').first().click();
        assert.ok(await landing.locator('#faq').isVisible());
        const firstQuestion=landing.locator('#faq summary').first();
        await firstQuestion.focus(); await landing.keyboard.press('Enter');
        assert.ok(await landing.locator('#faq details').first().evaluate(element=>element.open),'FAQ opens using the keyboard');
        assert.equal(await landing.locator('#faq a[href="login.html"]').count(),1);
        assert.equal(await landing.locator('#contact a[href="tel:+639338102144"]').count(),1);
        assert.equal(await landing.locator('#contact a[href="mailto:ultimateexpress.socials@gmail.com"]').count(),1);
        await landing.locator('#contact').screenshot({path:path.join(output,'landing-faq-desktop.png'),animations:'disabled'});
        await landing.setViewportSize({width:390,height:844});
        await firstQuestion.scrollIntoViewIfNeeded();
        assert.equal(await landing.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'FAQ fits the mobile viewport');
        await landing.locator('#faq').screenshot({path:path.join(output,'landing-faq-mobile.png'),animations:'disabled'});
        assert.deepEqual(faqRequests,[],'Reading FAQs does not submit an inquiry');

        // Seed an older inquiry only inside the temporary harness to verify its staff follow-up remains available.
        const olderInquiry=await landing.request.post(base+'/customer-account-requests',{data:{name:'UI Guest <img src=x onerror=alert(1)>',email:'ui.guest@example.invalid',phone:'09170000001',message:'Existing guest record retained after the public form is replaced by FAQ.'}});
        assert.equal(olderInquiry.status(),201);

        const dispatcher=await pageFor('dispatcher'); await dispatcher.goto(origin+'/Dispatcher.html');
        const guest=dispatcher.locator('.ue-inquiry-item').filter({hasText:'UI Guest'});
        await guest.locator('summary').click();
        assert.equal(await guest.locator('img').count(),0,'Guest messages must render as text');
        await guest.locator('[data-status]').selectOption('contacted'); await guest.locator('[data-notes]').fill('Dispatcher phoned guest; awaiting cargo details.');
        await guest.locator('[data-save]').click(); await dispatcher.getByText('Follow-up saved.',{exact:true}).waitFor();
        await dispatcher.screenshot({path:path.join(output,'dispatcher-inbox.png'),fullPage:true});

        const manager=await pageFor('manager'); await manager.goto(origin+'/Manager.html');
        await manager.locator('[onclick="showPanel(\'website-inquiries\')"]').click();
        const managerGuest=manager.locator('.ue-inquiry-item').filter({hasText:'UI Guest'}); await managerGuest.locator('summary').click();
        assert.equal(await managerGuest.locator('[data-notes]').inputValue(),'Dispatcher phoned guest; awaiting cargo details.');
        await manager.locator('[onclick="showPanel(\'pricing\')"]').click();
        const tariff=manager.locator('#routePricingManager form');
        for(const [name,value] of Object.entries({label:'UI Manila to Laguna · test van',base_fare:'1000',included_km:'10',per_km:'30',max_km:'1000',notes:'Local QA only'})) await tariff.locator(`[name=${name}]`).fill(value);
        await tariff.locator('[type=submit]').click(); await manager.getByText('Company tariff saved. Existing booking quotes are unchanged.').waitFor();

        await dispatcher.reload(); await dispatcher.locator('#openManualQuoteModal').click();
        const helper=dispatcher.locator('#manualPriceHelper'); await helper.locator('summary').click();
        await helper.locator('[data-rate]').selectOption({label:'Company · UI Manila to Laguna · test van'});
        await helper.locator('[data-distance]').fill('20'); await helper.locator('[data-extras]').fill('200');
        await helper.locator('[data-calculate]').click(); await helper.getByText(/Suggested amount:/).waitFor();
        await helper.locator('[data-use]').click(); assert.equal(await dispatcher.locator('#manualPrice').inputValue(),'1500.00');
        await dispatcher.screenshot({path:path.join(output,'quote-assistance.png'),fullPage:true});
        await dispatcher.locator('#manualQuoteModal .modal-footer .btn-outline').click();

        await manager.locator('[onclick="showPanel(\'revenue\')"]').click();
        assert.equal((await manager.locator('#panel-revenue h1').innerText()).trim(),'Records Overview');
        assert.ok(!/revenue/i.test(await manager.locator('body').innerText()),'Manager visible labels use Records and payments');
        await manager.locator('#panel-revenue').screenshot({path:path.join(output,'manager-records.png')});
        await manager.locator('[onclick="printManagerReport()"]').click(); await manager.locator('#ueDocumentPreview h1').waitFor();
        assert.ok((await manager.locator('#ueDocumentPreview').innerText()).includes('Monthly Operations'));
        await printPDF(manager,'management-report');
        await manager.evaluate(id => openTransactionReceipt(id),receiptId);
        await manager.locator('#receiptModal [onclick="printManagerReceipt()"]').click();
        assert.ok((await manager.locator('#ueDocumentPreview').innerText()).includes('customer3@example.invalid'));
        await printPDF(manager,'manager-receipt');
        await manager.locator('#receiptModal .modal-close').click();

        await dispatcher.evaluate(id => openInquiryReceipt('REQ-'+id),receiptId);
        await dispatcher.locator('#receiptModal .btn-primary').click();
        assert.ok((await dispatcher.locator('#ueDocumentPreview').innerText()).includes('Receipt UI Customer'));
        await printPDF(dispatcher,'dispatcher-receipt');
        await dispatcher.locator('#receiptModal .modal-close').click();

        const supervisor=await pageFor('supervisor'); await supervisor.goto(origin+'/Supervisor.html');
        await supervisor.locator('#truckMaintenance [data-truck]').selectOption({label:'TEST-PANEL-1 · 6-Wheeler Closed Van'});
        const maintenance=supervisor.locator('#truckMaintenance form');
        await maintenance.locator('[name=odometer]').fill('16000');
        await maintenance.locator('[name=tire_unit]').selectOption('mm');
        assert.equal(await maintenance.locator('[name=tire_front_left]').inputValue(),'','Switching units clears old readings');
        await maintenance.locator('[name=tire_front_right]').fill('1.5');
        const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'});
        const dateOffset=days=>new Date(Date.parse(today)+days*86400000).toISOString().slice(0,10);
        await maintenance.locator('[name=tire_checked_at]').fill(today);
        for(const [name,value] of Object.entries({vehicle_model:'2020 model',battery_serial:'UI-BATTERY-1 / UI-BATTERY-2',battery_installed_at:dateOffset(-40),battery_due_date:dateOffset(7),battery_notes:'Inspect terminals at scheduled service',fuel_filter_model:'UI-FUEL-FILTER-123',fuel_filter_installed_at:dateOffset(-30),fuel_filter_due_date:dateOffset(14),fuel_filter_notes:'Recorded by supervisor'})) {
            await maintenance.locator(`[name=${name}]`).fill(value);
        }
        await maintenance.locator('[type=submit]').click(); await supervisor.getByText('Maintenance record saved. Dispatch availability is unchanged.').waitFor();
        assert.equal(await supervisor.locator('[name=battery_serial]').inputValue(),'UI-BATTERY-1 / UI-BATTERY-2');
        assert.equal(await supervisor.locator('[name=fuel_filter_model]').inputValue(),'UI-FUEL-FILTER-123');
        await supervisor.locator('#truckMaintenance [data-print-battery]').click();
        assert.ok((await supervisor.locator('#ueDocumentPreview').innerText()).includes('UI-BATTERY-1 / UI-BATTERY-2'));
        await printPDF(supervisor,'battery-report');
        await supervisor.locator('#truckMaintenance [data-print-fuel]').click();
        assert.ok((await supervisor.locator('#ueDocumentPreview').innerText()).includes('UI-FUEL-FILTER-123'));
        await printPDF(supervisor,'fuel-filter-report');
        await supervisor.locator('#truckMaintenance [data-print-tires]').click();
        assert.ok((await supervisor.locator('#ueDocumentPreview').innerText()).includes('1.5'));
        await printPDF(supervisor,'tire-report');
        await supervisor.locator('#truckMaintenance [data-print-oil]').click(); await printPDF(supervisor,'oil-report');
        await supervisor.locator('[onclick="printFleetReport()"]').click(); await printPDF(supervisor,'fleet-report');
        await supervisor.screenshot({path:path.join(output,'maintenance-dashboard.png'),fullPage:true});
        await supervisor.setViewportSize({width:390,height:844});
        assert.ok(await supervisor.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),'Maintenance fits the phone viewport');
        await supervisor.screenshot({path:path.join(output,'maintenance-mobile.png'),fullPage:true});
        await manager.reload(); await manager.locator('[onclick="showPanel(\'maintenance\')"]').click();
        await manager.locator('#truckMaintenance [data-truck]').selectOption({label:'TEST-PANEL-1 · 6-Wheeler Closed Van'});
        assert.equal(await manager.locator('[name=battery_serial]').inputValue(),'UI-BATTERY-1 / UI-BATTERY-2');
        assert.equal(await manager.locator('[name=fuel_filter_due_date]').inputValue(),dateOffset(14));
        // Exercise the shared receipt print path against the same browser DOM used by both dashboards.
        await supervisor.evaluate(()=>UEDocuments.preview({title:'Service Receipt',reference:'REQ-QA',facts:[['Customer','Test Customer'],['Route','Manila to Laguna'],['Dispatcher quote',UEDocuments.money(1500)],['Paid amount','Not recorded']],note:'Quotation only. Payment has not been recorded.'}));
        await printPDF(supervisor,'service-receipt');

        const tripDispatcher=await pageFor('dispatcher',true);await tripDispatcher.goto(origin+'/Dispatcher.html');
        await tripDispatcher.waitForFunction(id=>inquiries.some(row=>row.requestId===id),uiBookingId);
        await tripDispatcher.evaluate(id=>openInquiryModal('REQ-'+id),uiBookingId);
        await tripDispatcher.waitForFunction(()=>document.getElementById('inquiryMapStatus').textContent.includes('20.0 km round trip'));
        await tripDispatcher.locator('#editPriceHelper summary').click();
        assert.equal(await tripDispatcher.locator('#editPriceHelper [data-distance]').inputValue(),'20.00','Pricing receives one-way map km multiplied by two');
        await tripDispatcher.locator('#inquiryModal .modal-content').screenshot({path:path.join(output,'round-trip-quote.png')});
        await tripDispatcher.locator('#completeDealBtn').click();
        await tripDispatcher.getByRole('alertdialog').getByRole('button',{name:'Save changes',exact:true}).click();
        await tripDispatcher.waitForFunction(()=>!document.getElementById('inquiryModal').classList.contains('active'));
        const current=await tripDispatcher.request.get(base+'/truck-maintenance',{headers:{Authorization:'Bearer '+sessions.supervisor}});
        const tripRecord=(await current.json()).rows.find(row=>row.id===uiTripTruckId);
        assert.equal(Number(tripRecord.odometer),1010,'Completing in the browser adds 20 km to the existing 990 km');assert.equal(tripRecord.oil_state,'due');

        await tripDispatcher.getByRole('link',{name:'Maintenance Check Form'}).click();
        const inspectionForm=tripDispatcher.locator('#maintenanceRequests [data-request-check]');
        await inspectionForm.locator('[name=truck_id]').selectOption(String(uiTripTruckId));
        await inspectionForm.locator('[name=priority]').selectOption('urgent');
        await inspectionForm.locator('[name=reason]').fill('Check tires after completed delivery <img src=x onerror=alert(1)>');
        await inspectionForm.locator('[type=submit]').click();
        await tripDispatcher.locator('#maintenanceRequests [data-check-message]').filter({hasText:'The Supervisor can now review it.'}).waitFor();
        const requestCard=tripDispatcher.locator('.ue-inspection-item').filter({hasText:'TEST-UI-TRIP'});await requestCard.locator('summary').click();
        assert.equal(await requestCard.locator('img').count(),0);
        await requestCard.locator('[data-check-print]').click();await printPDF(tripDispatcher,'maintenance-check-request');
        await tripDispatcher.locator('#maintenanceRequests').screenshot({path:path.join(output,'dispatcher-maintenance-request.png')});
        await supervisor.setViewportSize({width:1440,height:1000});await supervisor.reload();
        const reviewCard=supervisor.locator('.ue-inspection-item').filter({hasText:'TEST-UI-TRIP'});await reviewCard.locator('summary').click();
        await reviewCard.locator('[name=status]').selectOption('checked');await reviewCard.locator('[name=findings]').fill('Tire inspection completed. Actual readings recorded separately.');
        await supervisor.locator('[data-check-filter]').selectOption('checked');
        await supervisor.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();
        await supervisor.waitForFunction(()=>document.querySelector('[data-check-filter]').value==='open');
        assert.equal(await supervisor.locator('[data-check-filter]').inputValue(),'open','Cancelling a filter change retains the active inspection form');
        assert.equal(await reviewCard.locator('[name=findings]').inputValue(),'Tire inspection completed. Actual readings recorded separately.');
        await reviewCard.locator('[type=submit]').click();await supervisor.locator('#maintenanceRequests [data-check-message]').filter({hasText:'Inspection review saved.'}).waitFor();
        await tripDispatcher.locator('[data-check-refresh]').click();await tripDispatcher.locator('[data-check-filter]').selectOption('checked');
        const checked=tripDispatcher.locator('.ue-inspection-item').filter({hasText:'TEST-UI-TRIP'});await checked.locator('summary').click();
        assert.ok((await checked.innerText()).includes('Tire inspection completed.'));
        await tripDispatcher.setViewportSize({width:390,height:844});assert.equal(await tripDispatcher.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await tripDispatcher.locator('#maintenanceRequests').screenshot({path:path.join(output,'maintenance-request-mobile.png')});
        for(const {errors,role} of pages) assert.deepEqual(errors,[],role+' has no uncaught browser errors');
        console.log('Trip browser QA passed: round-trip map distance used for pricing; completion adds mileage and triggers reminder; Dispatcher maintenance form, Supervisor findings, shared status, printable request, Records labels and mobile layout.');
        console.log('Browser QA passed: public FAQ replaces the inquiry form and works by keyboard on desktop/mobile; existing inquiry follow-up and safe rendering; manager tariff entry and dispatcher estimate; supervisor maintenance and both units; battery/fuel-filter persistence across both staff dashboards; printable management, fleet, oil, tire, battery, fuel-filter and receipt documents; mobile preview.');
    } catch(error) {
        for (const {page,role,errors} of pages) {
            fs.writeFileSync(path.join(output,'overflow-'+role+'.json'),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.right>innerWidth+1;}).map(e=>({tag:e.tagName,id:e.id,class:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right}))),null,2));
            await page.screenshot({path:path.join(output,'failure-'+role+'.png'),fullPage:true}).catch(()=>{});
            if(errors.length) console.error(role+' browser errors:',errors.join('; '));
        }
        throw error;
    } finally { await browser.close(); }
};

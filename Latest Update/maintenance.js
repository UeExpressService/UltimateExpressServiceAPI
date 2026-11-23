(() => {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const positions = { front_right:'Front right',front_left:'Front left',rear_right_outer:'Rear right outer',rear_right_inner:'Rear right inner',rear_left_outer:'Rear left outer',rear_left_inner:'Rear left inner',
        second_rear_right_outer:'Second rear right outer',second_rear_right_inner:'Second rear right inner',second_rear_left_outer:'Second rear left outer',second_rear_left_inner:'Second rear left inner',spare:'Spare' };
    const oilLabels = {baseline_required:'Service baseline required',due:'Oil service due',due_soon:'Oil service due soon',scheduled:'Next service scheduled'};
    const tireLabels = {not_recorded:'No tire readings',danger:'Urgent tire inspection',replacement:'Review tire replacement',monitor:'Continue inspections'};
    const componentLabels = {not_recorded:'Not recorded',due_date_required:'Set a due date',overdue:'Check overdue',due:'Check due today',due_soon:'Check due within 14 days',scheduled:'Next check scheduled'};
    async function api(path,body) {
        const response = await fetch(window.UE_API_URL + path,{method:body?'PUT':'GET',headers:authenticatedApiHeaders({'Content-Type':'application/json'}),...(body?{body:JSON.stringify(body)}:{})});
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to load maintenance.'); return data;
    }
    document.addEventListener('DOMContentLoaded',() => {
        const root = document.getElementById('truckMaintenance'); if (!root) return;
        let rows = [], today, selected;
        root.innerHTML = `<div class="ue-revision-heading"><div><h2>Truck Maintenance</h2><p>Record oil service, tire checks, battery details and fuel-filter changes. Initial oil reminder: 5,000 km or 3 months, whichever comes first. Battery and fuel-filter reminders use the due dates entered by the Supervisor or Manager.</p></div>
            <div class="ue-maintenance-report-actions"><button type="button" class="ue-ops-button" data-print-oil>Print Oil Report</button> <button type="button" class="ue-ops-button" data-print-tires>Print Tire Report</button>
            <button type="button" class="ue-ops-button" data-print-battery>Print Battery Report</button> <button type="button" class="ue-ops-button" data-print-fuel>Print Fuel Filter Report</button></div></div>
            <p>Completed deliveries add their saved round-trip map kilometers to the recorded odometer once. Verify the estimate against the actual reading during inspection. Record a starting odometer before completing a delivery. Reminders support supervisor review and do not automatically change dispatch availability. Tire alerts follow the company sheet: replacement at 4/32 inch or below, danger at 2/32 inch or below.</p>
            <label class="ue-revision-filter">Truck <select data-truck><option value="">Choose a truck</option></select> <button type="button" class="ue-ops-button" data-refresh>Refresh</button></label>
            <p class="ue-revision-message" data-message role="status" aria-live="polite"></p><div data-editor></div><div data-summary class="ue-revision-scroll"></div>`;
        const message = root.querySelector('[data-message]'), selector = root.querySelector('[data-truck]'), editor = root.querySelector('[data-editor]');
        const val = value => value ?? '';
        function edit() {
            selected = rows.find(row => String(row.id) === selector.value);
            if (!selected) { editor.innerHTML = ''; return; }
            const row = selected;
            editor.innerHTML = `<form class="ue-revision-form"><label>Current odometer in km<input name="odometer" type="number" min="0" max="100000000" step="0.1" value="${val(row.odometer)}" placeholder="Leave blank if unknown"></label>
                <label>Oil interval in km<input name="oil_interval_km" type="number" min="1" max="100000" step="1" value="${row.oil_interval_km}" required></label>
                <label>Oil interval in months<input name="oil_interval_months" type="number" min="1" max="36" step="1" value="${row.oil_interval_months}" required></label>
                <label>Last oil-change odometer in km<input name="last_oil_km" type="number" min="0" max="100000000" step="0.1" value="${val(row.last_oil_km)}" placeholder="Leave blank if unknown"></label>
                <label>Last oil-change date<input name="last_oil_date" type="date" max="${today}" value="${val(row.last_oil_date)}"></label>
                <div><button type="button" class="ue-ops-button" data-oil-today>Oil changed today at this odometer</button></div>
                <label>Engine number<input name="engine_number" maxlength="100" value="${escape(row.engine_number)}"></label>
                <label>Oil filter model<input name="oil_filter" maxlength="200" value="${escape(row.oil_filter)}"></label>
                <label>Oil quantity in liters<input name="oil_liters" type="number" min="0" max="1000" step="0.01" value="${val(row.oil_liters)}"></label>
                <label>Vehicle model / year<input name="vehicle_model" maxlength="100" value="${escape(row.vehicle_model)}" placeholder="As shown in the vehicle record"></label>
                <fieldset class="ue-form-wide ue-maintenance-component"><legend>Battery Monitoring</legend><div class="ue-revision-form">
                    <label class="ue-form-wide">Battery serial number(s) / model<input name="battery_serial" maxlength="255" value="${escape(row.battery_serial)}" placeholder="Enter both serial numbers if the truck uses two batteries"></label>
                    <label>Date installed<input name="battery_installed_at" type="date" max="${today}" value="${val(row.battery_installed_at)}"></label>
                    <label>Due date / next check<input name="battery_due_date" type="date" value="${val(row.battery_due_date)}"></label>
                    <label class="ue-form-wide">Battery notes<textarea name="battery_notes" maxlength="1000" rows="2">${escape(row.battery_notes)}</textarea></label>
                    <p class="ue-form-wide">${escape(componentLabels[row.battery_state])}${row.battery_due_date ? ' · '+escape(row.battery_due_date) : ''}. Enter the actual service/check due date; no battery replacement lifespan is assumed.</p>
                </div></fieldset>
                <fieldset class="ue-form-wide ue-maintenance-component"><legend>Fuel Filter Monitoring</legend><div class="ue-revision-form">
                    <label class="ue-form-wide">Fuel-filter model / part number<input name="fuel_filter_model" maxlength="255" value="${escape(row.fuel_filter_model)}"></label>
                    <label>Date installed<input name="fuel_filter_installed_at" type="date" max="${today}" value="${val(row.fuel_filter_installed_at)}"></label>
                    <label>Due date / next check<input name="fuel_filter_due_date" type="date" value="${val(row.fuel_filter_due_date)}"></label>
                    <label class="ue-form-wide">Fuel-filter notes<textarea name="fuel_filter_notes" maxlength="1000" rows="2">${escape(row.fuel_filter_notes)}</textarea></label>
                    <p class="ue-form-wide">${escape(componentLabels[row.fuel_filter_state])}${row.fuel_filter_due_date ? ' · '+escape(row.fuel_filter_due_date) : ''}. The report uses the vehicle model and engine number entered above.</p>
                </div></fieldset>
                <label>Tire size<input name="tire_size" maxlength="100" value="${escape(row.tire_size)}"></label>
                <label>Tire reading unit<select name="tire_unit"><option value="32nds_inch" ${row.tire_unit!=='mm'?'selected':''}>1/32 inch (company sheet legend)</option><option value="mm" ${row.tire_unit==='mm'?'selected':''}>Millimeters</option></select></label>
                <label>Tire inspection date<input name="tire_checked_at" type="date" max="${today}" value="${val(row.tire_checked_at)}"></label>
                <p class="ue-form-wide">Enter only installed tire positions that were actually measured. Leave unmeasured positions blank. Switching the unit does not convert existing entered values; re-enter readings in the selected unit.</p>
                ${Object.entries(positions).map(([key,label]) => `<label>${label}<input name="tire_${key}" type="number" min="0" max="100" step="0.01" value="${val(row.tire_readings[key])}"></label>`).join('')}
                <label class="ue-form-wide">Inspection and service notes<textarea name="notes" rows="2" maxlength="2000">${escape(row.notes)}</textarea></label>
                <div class="ue-form-wide"><button type="submit" class="ue-ops-button">Save maintenance record</button> <button type="button" class="ue-ops-button" data-history>View history</button></div></form><div data-history-list></div>`;
            const form = editor.querySelector('form');
            for (const prefix of ['battery','fuel_filter']) {
                const installed = form.elements[prefix+'_installed_at'], due = form.elements[prefix+'_due_date'];
                const updateMinimum = () => { due.min = installed.value; };
                installed.addEventListener('change',updateMinimum); updateMinimum();
            }
            form.elements.tire_unit.addEventListener('change', () => {
                for (const key of Object.keys(positions)) form.elements['tire_'+key].value = '';
                form.elements.tire_checked_at.value = '';
                message.textContent = 'Tire values cleared. Enter measurements in the newly selected unit.';
            });
            form.querySelector('[data-oil-today]').addEventListener('click', () => {
                if (form.elements.odometer.value === '') { form.elements.odometer.focus(); message.textContent = 'Enter the current odometer first.'; return; }
                form.elements.last_oil_km.value = form.elements.odometer.value; form.elements.last_oil_date.value = today;
                message.textContent = 'Oil-change details entered. Save the maintenance record to retain them.';
            });
            form.querySelector('[data-history]').addEventListener('click', async () => {
                try {
                    const history = await api(`/trucks/${row.id}/maintenance-history`);
                    editor.querySelector('[data-history-list]').innerHTML = `<h3>Saved maintenance history</h3>${history.length ? history.map(event => {
                        const record = typeof event.snapshot === 'string' ? JSON.parse(event.snapshot) : event.snapshot;
                        return `<p>${escape(new Date(event.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'}))} · Odometer ${escape(record.odometer ?? 'Not recorded')} km · Last oil change ${escape(record.last_oil_date || 'Not recorded')} at ${escape(record.last_oil_km ?? 'Not recorded')} km
                            ${record.battery_serial || record.battery_installed_at || record.battery_due_date ? ` · Battery: ${escape(record.battery_serial || 'Serial not recorded')}, installed ${escape(record.battery_installed_at || 'Not recorded')}, due ${escape(record.battery_due_date || 'Not scheduled')}` : ''}
                            ${record.fuel_filter_model || record.fuel_filter_installed_at || record.fuel_filter_due_date ? ` · Fuel filter: ${escape(record.fuel_filter_model || 'Model not recorded')}, installed ${escape(record.fuel_filter_installed_at || 'Not recorded')}, due ${escape(record.fuel_filter_due_date || 'Not scheduled')}` : ''}
                            ${record.event_type==='completed_delivery_distance' ? ` · Completed delivery REQ-${escape(record.service_request_id)}: ${escape(record.one_way_km)} km × 2 = ${escape(record.round_trip_km)} km added (previous odometer ${escape(record.odometer_before)} km)` : ''}
                            · ${escape(record.notes || '')}</p>`;
                    }).join('') : '<p>No maintenance history recorded.</p>'}`;
                } catch(error) { message.textContent = error.message; }
            });
            form.addEventListener('submit',async event => {
                event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true;
                const body = Object.fromEntries(new FormData(form));
                for (const key of ['odometer','last_oil_km','oil_liters','oil_interval_km','oil_interval_months']) body[key] = body[key]===''?null:Number(body[key]);
                for(const key of ['last_oil_date','tire_checked_at','battery_installed_at','battery_due_date','fuel_filter_installed_at','fuel_filter_due_date']) body[key] ||= null;
                body.tire_readings = {}; body.version = row.version == null ? null : Number(row.version);
                for (const key of Object.keys(positions)) { const name = 'tire_'+key; body.tire_readings[key] = body[name]===''?null:Number(body[name]); delete body[name]; }
                try { await api(`/trucks/${row.id}/maintenance`,body); await load(); message.textContent = 'Maintenance record saved. Dispatch availability is unchanged.'; }
                catch(error) { message.textContent = error.message; } finally { button.disabled = false; }
            });
        }
        async function load() {
            try {
                const data = await api('/truck-maintenance'); rows=data.rows; today=data.today;
                const id=selector.value;
                selector.innerHTML = '<option value="">Choose a truck</option>'+rows.map(row => `<option value="${row.id}">${escape(row.license_plate)} · ${escape(row.type)}</option>`).join('');
                selector.value = id; edit();
                root.querySelector('[data-summary]').innerHTML = `<table><thead><tr><th>Truck</th><th>Odometer</th><th>Oil reminder</th><th>Next oil service</th><th>Tire reminder</th><th>Battery</th><th>Fuel filter</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.license_plate)}</td><td>${escape(row.odometer ?? 'Not recorded')}</td><td>${escape(oilLabels[row.oil_state])}</td><td>${escape(row.next_oil_km == null?'Baseline required':row.next_oil_km+' km')} · ${escape(row.next_oil_date || 'No service date')}</td><td>${escape(tireLabels[row.tire_state])}</td><td>${escape(componentLabels[row.battery_state])}${row.battery_due_date ? '<br>'+escape(row.battery_due_date) : ''}</td><td>${escape(componentLabels[row.fuel_filter_state])}${row.fuel_filter_due_date ? '<br>'+escape(row.fuel_filter_due_date) : ''}</td></tr>`).join('')}</tbody></table>`;
            } catch(error) { message.textContent = error.message; }
        }
        selector.addEventListener('change',edit);
        root.querySelector('[data-refresh]').addEventListener('click',async () => {
            if (selector.value && !(await UE.confirm('Refreshing replaces unsaved maintenance entries. Continue?',{title:'Refresh maintenance',confirmText:'Refresh'}))) return;
            load();
        });
        root.querySelector('[data-print-oil]').addEventListener('click',() => UEDocuments.preview({title:'Oil Filter and Engine Oil Report',landscape:true,
            sections:[{title:'Recorded truck oil service',columns:['Plate','Vehicle type','Liters','Engine','Oil filter','Last oil change','Odometer km','Next oil km','Reminder'],rows:rows.map(row => [row.license_plate,row.type,row.oil_liters,row.engine_number,row.oil_filter,row.last_oil_date,row.odometer,row.next_oil_km,oilLabels[row.oil_state]])}],
            note:'Initial reminder: 5,000 km or 3 months, whichever comes first, unless adjusted per truck. Missing records are not treated as completed service. Confirm manufacturer and company schedules.'}));
        root.querySelector('[data-print-tires]').addEventListener('click',() => UEDocuments.preview({title:'Tire Monitoring Report',landscape:true,
            sections:[
                {title:'Front and first rear axle',columns:['Checked','Plate','Unit',...Object.values(positions).slice(0,6)],rows:rows.map(row => [row.tire_checked_at,row.license_plate,row.tire_unit==='mm'?'mm':row.tire_unit?'1/32 inch':'Not recorded',...Object.keys(positions).slice(0,6).map(key => row.tire_readings[key])])},
                {title:'Second rear axle and spare',columns:['Plate','Tire size','Unit',...Object.values(positions).slice(6)],rows:rows.map(row => [row.license_plate,row.tire_size,row.tire_unit==='mm'?'mm':row.tire_unit?'1/32 inch':'Not recorded',...Object.keys(positions).slice(6).map(key => row.tire_readings[key])])}
            ],
            note:'Company sheet legend: 10/32 inch excellent; 5/32 good; 4/32 replacement; 2/32 danger. Millimeter readings are converted for alerts (1 inch = 25.4 mm). Blank means unmeasured or not applicable. Recorded readings alone do not establish roadworthiness.'}));
        root.querySelector('[data-print-battery]').addEventListener('click',() => UEDocuments.preview({title:'Battery Monitoring Report',landscape:true,
            sections:[{title:'Recorded battery details',columns:['Plate','Vehicle type','Serial number(s) / model','Date installed','Due date / next check','Reminder','Notes'],rows:rows.map(row => [row.license_plate,row.type,row.battery_serial,row.battery_installed_at,row.battery_due_date,componentLabels[row.battery_state],row.battery_notes])}],
            note:'Due dates are entered by the Supervisor or Manager as service/check reminders. No battery lifespan or replacement interval is assumed. Missing dates remain unrecorded.'}));
        root.querySelector('[data-print-fuel]').addEventListener('click',() => UEDocuments.preview({title:'Fuel Filter Monitoring Report',landscape:true,
            sections:[{title:'Recorded fuel-filter details',columns:['Plate','Vehicle type','Model / year','Engine','Fuel filter','Date installed','Due date / next check','Reminder','Notes'],rows:rows.map(row => [row.license_plate,row.type,row.vehicle_model,row.engine_number,row.fuel_filter_model,row.fuel_filter_installed_at,row.fuel_filter_due_date,componentLabels[row.fuel_filter_state],row.fuel_filter_notes])}],
            note:'Use the approved service schedule for each vehicle when entering due dates. Missing installation and due dates remain unrecorded.'}));
        load();
    });
})();

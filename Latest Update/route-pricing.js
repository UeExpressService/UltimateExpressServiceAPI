(() => {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money = value => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(value));
    async function api(path, body, method = 'POST') {
        const response = await fetch(window.UE_API_URL + path, { method: body ? method : 'GET',
            headers: authenticatedApiHeaders({ 'Content-Type':'application/json' }), ...(body ? { body:JSON.stringify(body) } : {}) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to load pricing.'); return data;
    }
    async function mount(root, targetId) {
        if (!root) return;
        if (targetId === 'manualPrice') return mountAutomatic(root, targetId);
        root.innerHTML = '<p>Loading quote assistance…</p>';
        try {
            const data = await api('/route-rates');
            if (!root.isConnected) return;
            const rates = [...data.company.filter(row => row.active), ...data.market];
            root.classList.add('ue-revision-card');
            root.innerHTML = `<details><summary><strong>Route price assistance</strong></summary>
                <p>Choose the appropriate vehicle and service area. Market references are comparison estimates; Dispatch agrees the final price with the guest.</p>
                <div class="ue-revision-form"><label class="ue-form-wide">Company tariff or market reference<select data-rate><option value="">Choose a reference</option>${rates.map(row => `<option value="${escape(row.id)}">${escape(row.market_reference ? 'Market reference · ' + row.label : 'Company · ' + row.label)}</option>`).join('')}</select></label>
                <label>Round-trip road distance in km<input data-distance type="number" min="0.01" max="10000" step="0.01" placeholder="One-way map km × 2"></label>
                <label>Additional charges in PHP<input data-extras type="number" min="0" max="10000000" step="0.01" value="0"></label></div>
                <p>Map distance includes the outbound and return trip (one-way km × 2). If entering a distance manually, enter the full round trip.</p><p data-details></p><button type="button" class="ue-ops-button" data-calculate>Calculate estimate</button>
                <button type="button" class="ue-ops-button" data-use disabled>Use this amount</button><p class="ue-revision-message" data-result role="status"></p></details>`;
            let estimate;
            const output = root.querySelector('[data-result]'), use = root.querySelector('[data-use]');
            const inputs = () => ({ rate_id:root.querySelector('[data-rate]').value, distance_km:Number(root.querySelector('[data-distance]').value), extras:Number(root.querySelector('[data-extras]').value) });
            function invalidate() { estimate = null; use.disabled = true; output.textContent = ''; }
            root.invalidateEstimate = invalidate;
            root.addEventListener('input', invalidate);
            root.querySelector('[data-rate]').addEventListener('change', () => {
                invalidate();
                const rate = rates.find(row => String(row.id) === inputs().rate_id);
                root.querySelector('[data-details]').innerHTML = rate ? `${escape(rate.label)}: ${money(rate.base_fare)} base + ${money(rate.per_km)} per km beyond ${Number(rate.included_km)} included km. Maximum ${Number(rate.max_km)} km.
                    ${escape(rate.notes)} ${rate.source_url ? `<a href="${escape(rate.source_url)}" target="_blank" rel="noopener">Published reference</a> · Checked ${escape(rate.reference_date)}` : ''}` : '';
            });
            root.querySelector('[data-calculate]').addEventListener('click', async event => {
                const button = event.currentTarget, payload = inputs(), signature = JSON.stringify(payload);
                invalidate(); button.disabled = true;
                try {
                    const result = await api('/route-estimates',payload);
                    if (signature !== JSON.stringify(inputs())) return;
                    estimate = result; use.disabled = false;
                    output.textContent = `Suggested amount: ${money(result.total)} = ${money(result.base_fare)} base + ${money(result.distance_charge)} distance + ${money(result.extras)} additional charges. ${result.market_reference ? 'External market reference, subject to review.' : 'Company tariff.'} Save the booking to retain the final quote.`;
                } catch(error) { output.textContent = error.message; }
                finally { button.disabled = false; }
            });
            use.addEventListener('click', () => {
                const input = document.getElementById(targetId);
                if (!estimate || !input || input.readOnly) return;
                input.value = estimate.total.toFixed(2); input.dispatchEvent(new Event('input',{bubbles:true}));
                output.textContent += ' Amount copied to the quote field. Review and save the booking.';
            });
        } catch(error) { root.textContent = error.message; }
    }
    async function mountAutomatic(root, targetId) {
        root.classList.add('ue-revision-card','ue-auto-pricing');
        root.innerHTML = '<p>Loading automatic pricing…</p>';
        try {
            const data = await api('/route-rates');
            if (!root.isConnected) return;
            const samples = data.provisional || [];
            if (!samples.length) throw Error('Automatic rates are unavailable. Enter a final quote manually.');
            const references = [...data.company.filter(row => row.active), ...data.market];
            root.innerHTML = `<h3>Automatic Pricing</h3><p class="ue-pricing-notice">Provisional sample rates — replace with approved company prices before issuing real quotations.</p>
                <div class="ue-revision-form"><label>Truck type<select data-auto-truck required><option value="">Choose a truck type</option>${samples.map(row => `<option value="${escape(row.id)}">${escape(row.truck_type)}</option>`).join('')}</select></label>
                <label>Round-trip distance (km)<input data-distance type="number" min="0.01" max="10000" step="0.01" placeholder="One-way km × 2"></label>
                <label>Additional charges (₱)<input data-auto-extras type="number" min="0" max="10000000" step="0.01" value="0"></label>
                <label>Rate basis<select data-auto-reference><option value="">Provisional rate for selected truck</option>${references.map(row => `<option value="${escape(row.id)}">${row.market_reference?'External reference':'Company tariff'} · ${escape(row.label)}</option>`).join('')}</select></label></div>
                <p>Distance includes pickup to destination and the return trip. The road map fills it when available; otherwise enter the full round-trip distance. Add agreed tolls, ferry, handling, and other charges above.</p>
                <div class="ue-auto-breakdown" data-auto-breakdown aria-live="polite">Choose a truck and enter the distance to see the calculation.</div>
                <p data-auto-status class="ue-revision-message" role="status"></p><button type="button" class="ue-ops-button" data-auto-use disabled>Use automatic amount</button>
                <details class="ue-auto-rate-table"><summary>View provisional rate table</summary><p>Generated example prices, not approved company tariffs. All distances below are round-trip kilometers. Extra charges are separate; no automatic tax or cargo surcharge is added.</p>
                <div class="ue-revision-scroll"><table><thead><tr><th>Truck type</th><th>Base fare</th><th>Included km</th><th>Per extra km</th></tr></thead><tbody>${samples.map(row => `<tr><td>${escape(row.truck_type)}</td><td>${money(row.base_fare)}</td><td>${Number(row.included_km)}</td><td>${money(row.per_km)}</td></tr>`).join('')}</tbody></table></div></details>`;
            const truck = root.querySelector('[data-auto-truck]'), distance = root.querySelector('[data-distance]');
            const extras = root.querySelector('[data-auto-extras]'), reference = root.querySelector('[data-auto-reference]');
            const breakdown = root.querySelector('[data-auto-breakdown]'), status = root.querySelector('[data-auto-status]');
            const use = root.querySelector('[data-auto-use]'), quote = document.getElementById(targetId);
            let automatic = !quote.value, copying = false, estimate = null, revision = 0, timer, distanceSource = '';
            const payload = () => ({rate_id:reference.value || truck.value,distance_km:Number(distance.value),extras:Number(extras.value)});
            const copy = () => {
                if (!estimate || quote.readOnly) return;
                copying = true; quote.value = estimate.total.toFixed(2); quote.dispatchEvent(new Event('input',{bubbles:true})); copying = false;
            };
            function recalculate() {
                clearTimeout(timer); const current = ++revision; estimate = null; use.disabled = true;
                if (automatic && !quote.readOnly) quote.value = '';
                if (!truck.value || !distance.value || !distance.checkValidity() || !extras.value || !extras.checkValidity()) {
                    breakdown.textContent = 'Choose a truck, enter a distance above zero, and enter valid extra charges (zero if none).';
                    status.textContent = automatic ? 'Waiting for pricing details.' : 'Final quote manually adjusted. Complete the details to compare with an estimate.';
                    return;
                }
                breakdown.textContent = 'Calculating estimate…';
                timer = setTimeout(async () => {
                    try {
                        const result = await api('/route-estimates',payload());
                        if (current !== revision || !root.isConnected) return;
                        estimate = result; use.disabled = false;
                        breakdown.innerHTML = `<dl><div><dt>Base fare · ${Number(result.included_km)} km included</dt><dd>${money(result.base_fare)}</dd></div><div><dt>Extra distance · ${Number(result.chargeable_km).toFixed(2)} km × ${money(result.per_km)}</dt><dd>${money(result.distance_charge)}</dd></div><div><dt>Additional charges</dt><dd>${money(result.extras)}</dd></div><div class="ue-auto-total"><dt>Suggested quote</dt><dd>${money(result.total)}</dd></div></dl><p>${money(result.base_fare)} + ${money(result.distance_charge)} + ${money(result.extras)} = ${money(result.total)}</p>`;
                        status.textContent = `${result.provisional?'Provisional sample rate.':result.market_reference?'External reference; check the vehicle and service area.':'Company tariff; check it matches the selected truck and route.'} ${automatic?'Final quote filled automatically; you can adjust it.':'Final quote manually adjusted and kept unchanged.'}`;
                        if (automatic) copy();
                    } catch(error) {
                        if (current !== revision) return;
                        breakdown.textContent = 'Estimate unavailable.'; status.textContent = error.message + ' You can enter a final quote manually.';
                    }
                },300);
            }
            quote.addEventListener('input', () => {
                if (copying) return;
                automatic = false; status.textContent = 'Final quote manually adjusted. Select “Use automatic amount” to restore the current estimate.';
            });
            truck.addEventListener('change', () => { reference.value = ''; recalculate(); });
            distance.addEventListener('input', () => { distanceSource = 'manual'; recalculate(); });
            extras.addEventListener('input', recalculate); reference.addEventListener('change', recalculate);
            use.addEventListener('click', () => { if (!estimate) return; automatic = true; copy(); status.textContent = 'Automatic amount restored. Review the final quote before saving.'; });
            root.setPricingDistance = value => {
                if (Number.isFinite(value) && value > 0) { distance.value = value.toFixed(2); distanceSource = 'map'; }
                else if (distanceSource === 'map') { distance.value = ''; distanceSource = ''; }
                else return;
                recalculate();
            };
            root.invalidatePricingRoute = () => { distance.value = ''; distanceSource = ''; recalculate(); };
            root.resetPricing = () => { automatic = true; distanceSource = ''; recalculate(); };
            root.pricingTruckType = () => samples.find(row => row.id === truck.value)?.truck_type || '';
            if (root.pendingPricingDistance != null) root.setPricingDistance(root.pendingPricingDistance);
        } catch(error) { root.textContent = error.message; }
    }
    function setDistance(root, distance) {
        if (root?.id === 'manualPriceHelper') {
            root.pendingPricingDistance = distance;
            root.setPricingDistance?.(distance);
            return;
        }
        const field = root?.querySelector('[data-distance]');
        if (!field) return;
        field.value = Number.isFinite(distance) && distance > 0 ? distance.toFixed(2) : '';
        root.invalidateEstimate?.();
    }
    async function manager(root) {
        root.innerHTML = `<div class="ue-revision-heading"><div><h2>Company Route Tariffs</h2><p>Add the company’s approved rates when available. A tariff applies only to the route, vehicle and conditions described in its name and notes.</p></div></div>
            <form class="ue-revision-form" data-form><label class="ue-form-wide">Route and vehicle description<input name="label" maxlength="200" required placeholder="Pickup area → destination · truck type"></label>
            <label>Base fare in PHP<input name="base_fare" type="number" min="0" step="0.01" required></label>
            <label>Round-trip km included in base fare<input name="included_km" type="number" min="0" step="0.01" value="0" required></label>
            <label>Additional PHP per km<input name="per_km" type="number" min="0" step="0.01" required></label>
            <label>Maximum round-trip distance in km<input name="max_km" type="number" min="0.01" max="10000" step="0.01" required></label>
            <label class="ue-form-wide">Conditions and inclusions<textarea name="notes" maxlength="1000" rows="2" placeholder="Service area, vehicle, tolls, waiting, VAT treatment and effective date"></textarea></label>
            <label>Status<select name="active"><option value="true">Active</option><option value="false">Inactive</option></select></label>
            <div><button type="submit" class="ue-ops-button">Save company tariff</button> <button type="button" class="ue-ops-button" data-new>New tariff</button></div></form>
            <p class="ue-revision-message" data-message role="status"></p><div data-rates></div>`;
        const form = root.querySelector('form'), message = root.querySelector('[data-message]'); let rates = [], editId;
        async function load() {
            try {
                const data = await api('/route-rates'); rates = data.company;
                root.querySelector('[data-rates]').innerHTML = rates.length ? `<div class="ue-revision-scroll"><table><thead><tr><th>Company tariff</th><th>Base</th><th>Included km</th><th>PHP per km</th><th>Maximum km</th><th>Status</th><th></th></tr></thead><tbody>${rates.map(row => `<tr><td>${escape(row.label)}</td><td>${money(row.base_fare)}</td><td>${escape(row.included_km)}</td><td>${money(row.per_km)}</td><td>${escape(row.max_km)}</td><td>${row.active?'Active':'Inactive'}</td><td><button type="button" class="ue-ops-button" data-edit="${Number(row.id)}">Edit</button></td></tr>`).join('')}</tbody></table></div>` : '<p>No approved company tariffs have been entered. Dispatch can view clearly labeled market references.</p>';
            } catch(error) { message.textContent = error.message; }
        }
        root.querySelector('[data-new]').addEventListener('click', () => { editId = null; form.reset(); message.textContent = 'New tariff.'; });
        root.addEventListener('click', event => {
            const button = event.target.closest('[data-edit]'); if (!button) return;
            const row = rates.find(row => Number(row.id) === Number(button.dataset.edit)); editId = row.id;
            for (const name of ['label','base_fare','included_km','per_km','max_km','notes']) form.elements[name].value = row[name];
            form.elements.active.value = row.active ? 'true':'false'; form.elements.label.focus();
        });
        form.addEventListener('submit', async event => {
            event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true;
            const body = Object.fromEntries(new FormData(form));
            for (const name of ['base_fare','included_km','per_km','max_km']) body[name] = Number(body[name]);
            body.active = body.active === 'true';
            try { await api('/route-rates' + (editId ? '/' + editId : ''),body,editId?'PUT':'POST'); editId = null; form.reset(); await load(); message.textContent = 'Company tariff saved. Existing booking quotes are unchanged.'; }
            catch(error) { message.textContent = error.message; } finally { button.disabled = false; }
        });
        await load();
    }
    window.UERoutePricing = { mount, setDistance };
    document.addEventListener('DOMContentLoaded', () => {
        const root = document.getElementById('routePricingManager'); if (root) manager(root);
        mount(document.getElementById('manualPriceHelper'),'manualPrice');
    });
})();

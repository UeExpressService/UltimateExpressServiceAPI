(() => {
    const page = document.documentElement.dataset.page;
    const $ = id => document.getElementById(id);
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = amount => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(amount);
    const stamp = value => value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
    const dateOnly = value => String(value || '').slice(0, 10);
    async function api(path, method = 'GET', body) {
        const response = await fetch(`${window.UE_API_URL}${path}`, { method,
            headers: authenticatedApiHeaders(body ? { 'Content-Type': 'application/json' } : {}),
            ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to complete this action.');
        return data;
    }
    const states = { not_sent: 'Not sent', changed: 'Details changed · resend required', awaiting_review: 'Awaiting review', reviewed: 'Reviewed' };
    let fleetBusy = false, shiftBusy = false, reviewBusy = false;
    async function loadFleet() {
        if (fleetBusy) return;
        fleetBusy = true;
        try {
            const data = await api('/customer/fleet');
            $('fleetCards').innerHTML = data.categories.map(item => `<article class="ue-fleet-option">
                <img src="images/${escape(item.image)}" alt="${escape(item.name)}" loading="lazy">
                <div><h3>${escape(item.name)}</h3><strong class="ue-fleet-price">From ${money(item.amount)}</strong>
                <span class="ue-availability ${item.available ? 'ue-available' : ''}">${item.available ? `${item.available} available now` : 'Ask Dispatch for availability'}</span>
                <button type="button" class="ue-ops-button" data-fleet="${escape(item.name)}">Request quote <i class="bi bi-arrow-right"></i></button></div>
            </article>`).join('');
            $('fleetUpdated').textContent = `Updated ${stamp(data.checked_at)} · Philippine time`;
            const select = $('quoteTruckType'), selected = select.value;
            select.innerHTML = '<option value="">Let Dispatch recommend a truck</option>' + data.categories.map(item => `<option>${escape(item.name)}</option>`).join('');
            select.value = selected;
        } catch (error) { $('fleetUpdated').textContent = error.message; }
        finally { fleetBusy = false; }
    }
    async function loadShifts() {
        if (shiftBusy) return;
        shiftBusy = true;
        try {
            const data = await api('/driver-shifts' + ($('shiftDate').value ? `?date=${$('shiftDate').value}` : ''));
            $('shiftDate').value = data.date;
            $('shiftDate').max = data.today;
            $('shiftMessage').textContent = 'Philippine time · One daily shift per driver. Attendance does not change trip availability.';
            $('shiftRows').innerHTML = data.rows.length ? data.rows.map(row => {
                const overnight = row.open_id && dateOnly(row.open_work_date) !== data.today;
                const action = row.open_id ? 'time-out' : !row.id ? 'time-in' : null;
                return `<tr><td>${escape(row.name)}</td><td>${stamp(row.time_in)}</td><td>${stamp(row.time_out)}</td>
                    <td>${overnight ? `Open shift from ${escape(dateOnly(row.open_work_date))}` : row.time_out ? 'Shift closed' : row.open_id ? 'Clocked in' : 'Not clocked in'}</td>
                    <td>${data.date === data.today && action ? `<button class="ue-ops-button" data-driver="${row.driver_id}" data-action="${action}">${action === 'time-in' ? 'Time in' : 'Time out'}</button>` : '—'}</td></tr>`;
            }).join('') : '<tr><td colspan="5">No drivers found.</td></tr>';
        } catch (error) { $('shiftMessage').textContent = error.message; }
        finally { shiftBusy = false; }
    }
    async function loadReviews() {
        if (reviewBusy || $('bookingReviews').contains(document.activeElement)) return;
        reviewBusy = true;
        try {
            const rows = await api('/supervisor/confirmed-bookings');
            $('bookingReviews').innerHTML = rows.length ? rows.map(row => `<article class="ue-review-item">
                <div class="ue-ops-heading"><h3>Booking #${row.id} · ${escape(row.customer_name)}</h3><span class="ue-availability">${escape(states[row.state])}</span></div>
                <p>${escape(row.pickup_location)} → ${escape(row.delivery_location)}</p>
                <dl class="ue-review-details"><div><dt>Cargo</dt><dd>${escape(row.cargo_type)}</dd></div>
                <div><dt>Pickup</dt><dd>${escape(dateOnly(row.pickup_date))} ${escape(row.preferred_time)}</dd></div>
                <div><dt>Driver / truck</dt><dd>${escape(row.driver_name || 'Unassigned')} · ${escape(row.license_plate || 'Unassigned')}</dd></div>
                <div><dt>Quote / trip status</dt><dd>${money(row.quoted_amount || 0)} · ${escape(row.status)}</dd></div></dl>
                ${row.state === 'reviewed' ? `<p>Reviewed ${stamp(row.reviewed_at)}</p><p>${escape(row.notes)}</p>` :
                    row.state === 'changed' ? '<p>Booking details changed. Dispatch must save and resend this booking.</p>' :
                    ['approved', 'ongoing', 'completed'].includes(row.status) ? `<form data-review="${row.id}" data-version="${row.version}"><label for="reviewNotes${row.id}">Review notes (optional)</label><textarea id="reviewNotes${row.id}" maxlength="2000" rows="2"></textarea><button class="ue-ops-button" type="submit">Mark reviewed</button></form>` : '<p>This booking is no longer confirmed.</p>'}
                <p class="ue-ops-message" role="status"></p>
            </article>`).join('') : '<p class="ue-ops-empty">No bookings sent for review yet. Confirmed bookings appear here when Dispatch sends them.</p>';
            $('reviewMessage').textContent = 'Review is informational. Dispatch can proceed while a booking awaits review.';
        } catch (error) { $('reviewMessage').textContent = error.message; }
        finally { reviewBusy = false; }
    }
    let currentBooking = null, handoffSequence = 0;
    window.UEOperations = {
        async openHandoff(bookingId) {
            currentBooking = bookingId;
            const sequence = ++handoffSequence;
            $('handoffMessage').textContent = 'Loading supervisor review status…';
            $('sendSupervisorBtn').disabled = true;
            try {
                const data = await api(`/service-requests/${bookingId}/supervisor-review`);
                if (sequence !== handoffSequence) return;
                $('handoffMessage').textContent = `${states[data.state]}. Save booking changes before sending. Dispatch can proceed without waiting for review.`;
                $('sendSupervisorBtn').disabled = data.can_send === false || ['reviewed', 'awaiting_review'].includes(data.state);
                if (data.can_send === false) $('handoffMessage').textContent = 'Confirm and save the booking with a driver and truck before sending it to the Supervisor.';
            } catch (error) { if (sequence === handoffSequence) $('handoffMessage').textContent = error.message; }
        }
    };
    document.addEventListener('DOMContentLoaded', () => {
        if (page === 'customer') {
            loadFleet();
            $('refreshFleet').addEventListener('click', loadFleet);
            $('fleetCards').addEventListener('click', event => {
                const button = event.target.closest('[data-fleet]');
                if (!button) return;
                $('openQuoteModal').click();
                $('quoteTruckType').value = button.dataset.fleet;
                $('quoteTruckType').focus();
            });
        }
        if (page === 'supervisor') {
            loadShifts(); loadReviews();
            $('shiftDate').addEventListener('change', loadShifts);
            $('refreshAttendance').addEventListener('click', loadShifts);
            $('refreshReviews').addEventListener('click', loadReviews);
            $('shiftRows').addEventListener('click', async event => {
                const button = event.target.closest('[data-driver]');
                if (!button || button.disabled) return;
                button.disabled = true;
                try { await api(`/drivers/${button.dataset.driver}/${button.dataset.action}`, 'POST'); await loadShifts(); }
                catch (error) { $('shiftMessage').textContent = error.message; }
                finally { if (button.isConnected) button.disabled = false; }
            });
            $('bookingReviews').addEventListener('submit', async event => {
                const form = event.target.closest('[data-review]');
                if (!form) return;
                event.preventDefault();
                const button = form.querySelector('button'); button.disabled = true;
                try {
                    await api(`/service-requests/${form.dataset.review}/supervisor-review`, 'PUT', { version: form.dataset.version, notes: form.querySelector('textarea').value });
                    button.blur(); await loadReviews();
                } catch (error) { form.parentElement.querySelector('[role=status]').textContent = error.message; }
                finally { if (button.isConnected) button.disabled = false; }
            });
        }
        if (page === 'dispatcher') $('sendSupervisorBtn').addEventListener('click', async () => {
            if (!currentBooking) return;
            $('sendSupervisorBtn').disabled = true;
            try { await api(`/service-requests/${currentBooking}/supervisor-review`, 'POST'); await window.UEOperations.openHandoff(currentBooking); }
            catch (error) { $('handoffMessage').textContent = error.message; $('sendSupervisorBtn').disabled = false; }
        });
        setInterval(() => {
            if (document.hidden) return;
            if (page === 'customer') loadFleet();
            if (page === 'supervisor') { loadShifts(); loadReviews(); }
        }, 60000);
    });
})();

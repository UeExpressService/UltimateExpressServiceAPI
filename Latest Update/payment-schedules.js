(() => {
    const $ = id => document.getElementById(id), role = document.documentElement.dataset.page;
    const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const amount = value => value == null ? 'No quote' : new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(value);
    const labels = {upcoming:'Upcoming',overdue:'Overdue',due_today:'Due today',paid:'Paid',cancelled:'Cancelled'};
    let rows=[], trigger=null, booking=null, sequence=0;
    async function api(path,method='GET',body) {
        const response=await fetch(window.UE_API_URL+path,{method,headers:authenticatedApiHeaders(body?{'Content-Type':'application/json'}:{}),...(body?{body:JSON.stringify(body)}:{})});
        const data=await response.json();
        if(!response.ok)throw Error(data.error || 'Unable to load payment schedules.');
        return data;
    }
    function render() {
        const filter=$('scheduleFilter').value, search=$('scheduleSearch').value.toLowerCase();
        const filtered=rows.filter(row=>(!filter||row.payment_status===filter)&&`${row.id} ${row.customer_name} ${row.pickup_location} ${row.delivery_location}`.toLowerCase().includes(search));
        $('scheduleRows').innerHTML=filtered.map(row=>`<tr><td>#${row.id}<small>${escape(row.customer_name)}</small></td><td>${escape(row.due_date)}</td>
            <td>${amount(row.quoted_amount)}</td><td><span class="ue-schedule-state ue-schedule-${row.payment_status}">${labels[row.payment_status] || escape(row.payment_status)}</span></td>
            <td>${row.paid_amount==null?'—':amount(row.paid_amount)}</td><td>${escape(row.notes || '—')}</td></tr>`).join('')||'<tr><td colspan="6">No payment schedules match this view.</td></tr>';
        $('scheduleCount').textContent=`${filtered.length} scheduled payment${filtered.length===1?'':'s'}. Dates use Philippine time. Scheduling does not record payment or add revenue.`;
    }
    async function load() {
        $('scheduleMessage').textContent='Loading schedules…';
        try {rows=await api('/payment-schedules');render();$('scheduleMessage').textContent='';}
        catch(error){$('scheduleMessage').textContent=error.message;}
    }
    window.UEPaymentSchedules={
        async open() {trigger=document.activeElement;$('scheduledPaymentsModal').classList.add('active');$('scheduleFilter').focus();await load();},
        async openBooking(id) {
            if(role!=='dispatcher')return;
            booking=id;const ticket=++sequence;
            const section=document.createElement('section');section.className='form-section ue-booking-payment-schedule';
            section.innerHTML='<div class="section-title">Payment schedule</div><p class="ue-ops-message">Save the confirmed booking and quote first. Setting a due date does not record a payment.</p><label for="bookingDueDate">Payment due date</label><input type="date" id="bookingDueDate" min="2000-01-01" max="2099-12-31"><label for="bookingPaymentNotes">Payment notes (optional)</label><textarea id="bookingPaymentNotes" maxlength="1000" rows="2"></textarea><div class="ue-schedule-actions"><button type="button" id="saveBookingSchedule" class="ue-ops-button">Save payment schedule</button><button type="button" id="removeBookingSchedule" class="ue-ops-button">Remove schedule</button></div><p id="bookingScheduleMessage" class="ue-ops-message" role="status">Loading…</p>';
            $('inquiryFormColumn').append(section);
            const save=$('saveBookingSchedule'), remove=$('removeBookingSchedule');save.disabled=remove.disabled=true;
            async function persist(clear) {
                save.disabled=remove.disabled=true;
                try {
                    const data=await api(`/service-requests/${id}/payment-schedule`,'PUT',{due_date:clear?null:$('bookingDueDate').value,notes:$('bookingPaymentNotes').value});
                    if(ticket!==sequence)return;
                    if(clear)$('bookingDueDate').value='';
                    $('bookingScheduleMessage').textContent=data.message;
                }catch(error){if(ticket===sequence)$('bookingScheduleMessage').textContent=error.message;}
                finally{if(ticket===sequence)save.disabled=remove.disabled=false;}
            }
            save.addEventListener('click',()=>persist(false));remove.addEventListener('click',()=>persist(true));
            try {
                const data=await api(`/service-requests/${id}/payment-schedule`);
                if(ticket!==sequence||booking!==id)return;
                $('bookingDueDate').value=data.due_date||'';$('bookingPaymentNotes').value=data.notes||'';
                const locked=data.paid_amount!=null||data.status==='cancelled';
                $('bookingDueDate').disabled=$('bookingPaymentNotes').disabled=locked;
                save.disabled=remove.disabled=locked;
                $('bookingScheduleMessage').textContent=locked?'Payment is recorded or the booking is cancelled; this schedule is locked.':data.due_date?`Saved due date: ${data.due_date}.`:'No due date saved yet.';
            }catch(error){if(ticket===sequence)$('bookingScheduleMessage').textContent=error.message;}
        }
    };
    document.addEventListener('DOMContentLoaded',()=>{
        const modal=document.createElement('div');modal.className='modal-overlay ue-schedules-modal';modal.id='scheduledPaymentsModal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','scheduledPaymentsTitle');
        modal.innerHTML=`<div class="ue-schedules-content"><div class="ue-ops-heading"><h2 id="scheduledPaymentsTitle">Scheduled payments</h2><button type="button" id="closeSchedules" class="ue-ops-button" aria-label="Close scheduled payments">Close</button></div>
            <p>${role==='manager'?'View the due dates entered by Dispatch. Confirm received payments in Transactions.':'View saved payment due dates. Open a confirmed inquiry to add or update its schedule.'}</p>
            <div class="ue-schedule-controls"><label for="scheduleFilter">Show<select id="scheduleFilter"><option value="">All schedules</option><option value="upcoming">Upcoming</option><option value="due_today">Due today</option><option value="overdue">Overdue</option><option value="paid">Paid</option><option value="cancelled">Cancelled</option></select></label><label for="scheduleSearch">Search<input type="search" id="scheduleSearch" placeholder="Booking or customer"></label><button type="button" id="refreshSchedules" class="ue-ops-button">Refresh</button></div>
            <p id="scheduleMessage" class="ue-ops-message" role="status"></p><p id="scheduleCount" class="ue-ops-message"></p><div class="ue-ops-table"><table><thead><tr><th>Booking / customer</th><th>Due date</th><th>Dispatcher quote</th><th>Payment status</th><th>Paid amount</th><th>Notes</th></tr></thead><tbody id="scheduleRows"></tbody></table></div></div>`;
        document.body.append(modal);
        const close=()=>{modal.classList.remove('active');if(trigger?.isConnected)trigger.focus();};
        $('closeSchedules').addEventListener('click',close);modal.addEventListener('click',event=>{if(event.target===modal)close();});
        document.addEventListener('keydown',event=>{
            if(!modal.classList.contains('active'))return;
            if(event.key==='Escape')close();
            if(event.key==='Tab'){const items=[...modal.querySelectorAll('button,input,select')].filter(item=>!item.disabled),first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
        });
        $('scheduleFilter').addEventListener('change',render);$('scheduleSearch').addEventListener('input',render);$('refreshSchedules').addEventListener('click',load);
    });
})();

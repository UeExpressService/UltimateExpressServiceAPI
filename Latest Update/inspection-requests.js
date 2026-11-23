(() => {
    const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const statusNames={pending:'Pending Supervisor check',in_progress:'Inspection in progress',checked:'Checked by Supervisor'};
    const date=value=>new Date(value).toLocaleString('en-PH',{timeZone:'Asia/Manila'});
    async function api(path,method='GET',body) {
        const response=await fetch(window.UE_API_URL+path,{method,headers:authenticatedApiHeaders({'Content-Type':'application/json'}),...(body?{body:JSON.stringify(body)}:{})});
        const result=await response.json();if(!response.ok)throw Error(result.error||'Unable to process the maintenance check.');return result;
    }
    document.addEventListener('DOMContentLoaded',async()=>{
        const root=document.getElementById('maintenanceRequests');if(!root)return;
        const role=document.documentElement.dataset.page,dispatcher=role==='dispatcher',supervisor=role==='supervisor';
        let requests=[],lastFilter='open';
        root.innerHTML=`<div class="ue-revision-heading"><div><h2>Maintenance Check Requests</h2><p>${dispatcher?'Request a Supervisor inspection of a truck and follow the findings here.':supervisor?'Review truck checks requested by Dispatch and record your findings.':'View truck checks requested by Dispatch and the Supervisor’s findings.'}</p></div><button type="button" class="ue-ops-button" data-check-refresh>Refresh requests</button></div>
            <p>For urgent concerns, contact the Supervisor directly. A request does not change truck availability. Record actual readings and service work in Truck Maintenance.</p>
            ${dispatcher?`<form class="ue-revision-form" data-request-check><label>Truck<select name="truck_id" required><option value="">Loading trucks...</option></select></label><label>Priority<select name="priority"><option value="normal">Normal</option><option value="urgent">Urgent</option></select></label>
            <label class="ue-form-wide">Reason for the check<textarea name="reason" required maxlength="2000" rows="3" placeholder="Describe the issue, such as unusual noise, tire condition, or an odometer baseline that needs recording."></textarea></label>
            <div class="ue-form-wide"><button type="submit" class="ue-ops-button">Request Supervisor Check</button></div></form>`:''}
            <p class="ue-revision-message" data-check-message role="status" aria-live="polite"></p>
            <label class="ue-revision-filter">Show <select data-check-filter><option value="open">Open requests</option><option value="all">All recent requests</option><option value="checked">Checked requests</option></select></label>
            <div data-check-list></div>`;
        const message=root.querySelector('[data-check-message]');
        function render(){
            const filter=root.querySelector('[data-check-filter]').value;
            lastFilter=filter;
            const rows=requests.filter(row=>filter==='all'||(filter==='checked'?row.status==='checked':row.status!=='checked'));
            root.querySelector('[data-check-list]').innerHTML=rows.length?rows.map(row=>`<details class="ue-inspection-item" data-check-id="${row.id}"><summary><strong>MC-${row.id} · ${escape(row.license_plate||'Truck removed')}</strong><span>${escape(statusNames[row.status])} · ${row.priority==='urgent'?'Urgent':'Normal'}</span></summary>
                <p><strong>Truck</strong> ${escape(row.truck_type||'Not available')} · <strong>Requested by</strong> ${escape(row.requested_by_name||'Former staff member')} · ${escape(date(row.created_at))}</p>
                <p class="ue-inspection-text"><strong>Reason</strong> ${escape(row.reason)}</p>
                <p class="ue-inspection-text"><strong>Supervisor findings</strong> ${escape(row.findings||'Awaiting inspection')}${row.reviewed_by_name?' · '+escape(row.reviewed_by_name):''}</p>
                ${supervisor?`<form class="ue-revision-form" data-review-check><label>Review status<select name="status" ${row.status==='checked'?'disabled':''}>${row.status==='checked'?'<option value="checked">Checked by Supervisor</option>':`<option value="in_progress" ${row.status==='in_progress'?'selected':''}>Inspection in progress</option><option value="checked">Checked by Supervisor</option>`}</select></label>
                <label class="ue-form-wide">Findings and next action<textarea name="findings" maxlength="2000" rows="3" placeholder="Record what was checked and any action needed before marking this request checked.">${escape(row.findings)}</textarea></label><div class="ue-form-wide"><button type="submit" class="ue-ops-button">Save inspection review</button></div></form>`:''}
                <button type="button" class="ue-ops-button" data-check-print="${row.id}">Print Maintenance Form</button><p data-review-message role="status"></p></details>`).join(''):'<p>No matching maintenance check requests.</p>';
        }
        async function load(){requests=await api('/maintenance-requests');render();}
        root.querySelector('[data-check-filter]').addEventListener('change',async()=>{
            if(root.querySelector('details[open] form')&&!await UE.confirm('Changing the filter will close the inspection form. Continue?',{title:'Change request filter',confirmText:'Change filter'})){root.querySelector('[data-check-filter]').value=lastFilter;return;}
            render();
        });
        root.querySelector('[data-check-refresh]').addEventListener('click',async()=>{
            if(root.querySelector('details[open] form')&&!await UE.confirm('Refresh will replace any unsaved inspection findings. Continue?',{title:'Refresh requests',confirmText:'Refresh'}))return;
            try{await load();message.textContent='Maintenance requests refreshed.';}catch(error){message.textContent=error.message;}
        });
        if(dispatcher){
            const form=root.querySelector('[data-request-check]');
            try{
                const trucks=await api('/trucks');
                form.elements.truck_id.innerHTML='<option value="">Choose a truck</option>'+trucks.map(truck=>`<option value="${truck.id}">${escape(truck.license_plate)} · ${escape(truck.type)}</option>`).join('');
            }catch(error){message.textContent=error.message;form.elements.truck_id.innerHTML='<option value="">Unable to load trucks</option>';}
            form.addEventListener('submit',async event=>{
                event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
                try{
                    const result=await api('/maintenance-requests','POST',{truck_id:Number(form.elements.truck_id.value),priority:form.elements.priority.value,reason:form.elements.reason.value});
                    form.reset();root.querySelector('[data-check-filter]').value='open';await load();message.textContent=`MC-${result.id}: ${result.message}`;
                }catch(error){message.textContent=error.message;}finally{button.disabled=false;}
            });
        }
        root.addEventListener('submit',async event=>{
            if(!event.target.matches('[data-review-check]'))return;
            event.preventDefault();const form=event.target,item=form.closest('[data-check-id]'),row=requests.find(row=>Number(row.id)===Number(item.dataset.checkId));
            const button=form.querySelector('[type=submit]'),feedback=item.querySelector('[data-review-message]');button.disabled=true;
            try{
                const result=await api('/maintenance-requests/'+row.id,'PUT',{status:form.elements.status.value,findings:form.elements.findings.value,version:Number(row.version)});
                await load();message.textContent=result.message;
            }catch(error){feedback.textContent=error.message;}finally{button.disabled=false;}
        });
        root.addEventListener('click',event=>{
            const button=event.target.closest('[data-check-print]');if(!button)return;
            const row=requests.find(row=>Number(row.id)===Number(button.dataset.checkPrint));
            UEDocuments.preview({title:'Maintenance Inspection Request',reference:'MC-'+row.id,
                facts:[['Truck plate',row.license_plate||'Truck removed'],['Vehicle type',row.truck_type],['Priority',row.priority],['Status',statusNames[row.status]],['Requested by',row.requested_by_name],['Requested at',date(row.created_at)],['Reason',row.reason],['Supervisor',row.reviewed_by_name||'Not reviewed'],['Findings and next action',row.findings||'Awaiting inspection']],
                note:'An inspection request does not certify that the truck is roadworthy. Record actual service work and readings in Truck Maintenance and update fleet availability separately.'});
        });
        try{await load();}catch(error){message.textContent=error.message;}
        setInterval(()=>{if(!document.hidden&&root.getClientRects().length&&!root.querySelector('details[open]'))load().catch(error=>{message.textContent=error.message;});},30000);
    });
})();

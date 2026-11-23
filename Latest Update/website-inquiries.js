(() => {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const stamp = value => value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'Not recorded';
    const labels = { pending: 'New', contacted: 'Contacted', processed: 'Closed / processed', declined: 'Declined' };
    const api = async (path = '', body) => {
        const response = await fetch(window.UE_API_URL + '/website-inquiries' + path, {
            method: body ? 'PUT' : 'GET', headers: authenticatedApiHeaders({ 'Content-Type': 'application/json' }),
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load website inquiries.');
        return data;
    };
    document.addEventListener('DOMContentLoaded', () => {
        const root = document.getElementById('websiteInquiries');
        if (!root) return;
        let rows = [], busy = false;
        root.innerHTML = `<div class="ue-revision-heading"><div><h2>Website Inquiries <span id="websiteInquiryCount"></span></h2>
            <p>Messages sent from the landing page, including guests without an account. Contact the guest by email or phone and record your follow-up here.</p></div>
            <button type="button" class="ue-ops-button" data-refresh>Refresh</button></div>
            <label class="ue-revision-filter">Show <select data-filter><option value="open">Open inquiries</option><option value="all">All inquiries</option>
            ${Object.entries(labels).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
            <p class="ue-revision-message" data-message role="status" aria-live="polite"></p><div data-list></div>`;
        const message = root.querySelector('[data-message]'), list = root.querySelector('[data-list]');
        function render() {
            const filter = root.querySelector('[data-filter]').value;
            const visible = rows.filter(row => filter === 'all' || (filter === 'open' ? ['pending','contacted'].includes(row.status) : row.status === filter));
            const count = rows.filter(row => row.status === 'pending').length;
            document.getElementById('websiteInquiryCount').textContent = `(${count} new)`;
            const badge = document.getElementById('websiteInquiryBadge');
            if (badge) badge.textContent = count;
            list.innerHTML = visible.length ? visible.map(row => `<details class="ue-inquiry-item" data-id="${Number(row.id)}">
                <summary><strong>WEB-${Number(row.id)} · ${escape(row.name)}</strong><span>${escape(labels[row.status] || row.status)} · ${escape(stamp(row.created_at))}</span></summary>
                <div class="ue-inquiry-body"><p><strong>Company:</strong> ${escape(row.company || 'Not provided')}</p>
                <p><strong>Email:</strong> <a href="mailto:${encodeURIComponent(row.email)}">${escape(row.email)}</a>
                ${row.phone ? ` · <strong>Phone:</strong> <a href="tel:${escape(String(row.phone).replace(/[^+\d]/g,''))}">${escape(row.phone)}</a>` : ''}</p>
                <p class="ue-inquiry-text">${escape(row.message)}</p><p>First contact recorded: ${escape(stamp(row.contacted_at))}</p>
                <label>Follow-up status<select data-status>${Object.entries(labels).map(([value,label]) => `<option value="${value}" ${row.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
                <label>Follow-up notes<textarea data-notes maxlength="2000" rows="3" placeholder="Record the call or email outcome and next action">${escape(row.followup_notes || '')}</textarea></label>
                <button type="button" class="ue-ops-button" data-save>Save follow-up</button>
                <p class="ue-revision-message" data-result role="status"></p></div></details>`).join('') : '<p>No website inquiries match this filter.</p>';
        }
        async function refresh() {
            // Do not overwrite a follow-up being typed or an expanded inquiry during polling.
            if (busy) return;
            busy = true;
            try { rows = await api(); render(); message.textContent = `Updated ${stamp(new Date())} · Philippine time`; }
            catch (error) { message.textContent = error.message; }
            finally { busy = false; }
        }
        root.querySelector('[data-refresh]').addEventListener('click', () => {
            if (list.querySelector('details[open]')) { message.textContent = 'Save your follow-up and close the inquiry before refreshing.'; return; }
            refresh();
        });
        root.querySelector('[data-filter]').addEventListener('change', render);
        root.addEventListener('click', async event => {
            const button = event.target.closest('[data-save]');
            if (!button) return;
            const item = button.closest('[data-id]'), result = item.querySelector('[data-result]');
            button.disabled = true;
            try {
                await api('/' + item.dataset.id, { status: item.querySelector('[data-status]').value, notes: item.querySelector('[data-notes]').value });
                const row = rows.find(row => Number(row.id) === Number(item.dataset.id));
                row.status = item.querySelector('[data-status]').value;
                row.followup_notes = item.querySelector('[data-notes]').value;
                result.textContent = 'Follow-up saved. Email and phone links open your own email or calling app; no message is sent automatically.';
                item.open = false;
                await refresh();
                message.textContent = 'Follow-up saved.';
            } catch (error) { result.textContent = error.message; }
            finally { button.disabled = false; }
        });
        refresh();
        setInterval(() => { if (!document.hidden && !list.querySelector('details[open]')) refresh(); }, 30000);
    });
})();

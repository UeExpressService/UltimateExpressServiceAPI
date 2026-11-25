(() => {
    let dialog, objectUrl, controller, previousFocus, keyHandler;
    const titles = { payments: 'Management Report', bookings: 'Booking and Delivery Report', fleet: 'Fleet and Driver Activity Report' };

    function clearOutput() {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        if (!dialog) return;
        dialog.querySelector('[data-preview]').removeAttribute('src');
        dialog.querySelector('[data-output]').hidden = true;
        dialog.querySelector('[data-download]').removeAttribute('href');
    }

    function close() {
        controller?.abort(); controller = null;
        if (keyHandler) document.removeEventListener('keydown', keyHandler);
        keyHandler = null;
        clearOutput(); dialog?.remove(); dialog = null;
        document.body.classList.remove('ue-operational-report-open');
        previousFocus?.focus();
    }

    function open(type = 'payments') {
        if (!Object.hasOwn(titles, type)) return;
        const manager = getCurrentUser()?.role === 'manager';
        if (type === 'payments' && !manager) type = 'fleet';
        close(); previousFocus = document.activeElement;
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
        dialog = document.createElement('section');
        dialog.className = 'ue-operational-report-dialog';
        dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'ueOperationalReportTitle');
        dialog.innerHTML = `<div class="ue-operational-report-content">
            <header><div><h2 id="ueOperationalReportTitle">Generate Operational Report</h2>
            <p>Choose a period to summarize bookings, delivery status, and assigned trips.</p></div>
            <button type="button" data-close aria-label="Close report generator">Close</button></header>
            <form class="ue-operational-report-form">
                <label>Report<select name="type">${manager ? '<option value="payments">Management Report</option>' : ''}<option value="bookings">Booking and Delivery Report</option><option value="fleet">Fleet and Driver Activity Report</option></select></label>
                <label>Period<select name="period"><option value="month">Monthly</option><option value="custom">Custom dates</option></select></label>
                <label data-month>Reporting month<input type="month" name="month" min="2000-01" max="2099-12" required></label>
                <label data-custom hidden>From<input type="date" name="from" min="2000-01-01" max="2099-12-31"></label>
                <label data-custom hidden>To<input type="date" name="to" min="2000-01-01" max="2099-12-31"></label>
                <button type="submit">Generate PDF</button>
            </form>
            <p class="ue-operational-report-note">Select up to 366 days. The report uses the pickup date, or the creation date when no pickup date is saved. Statuses reflect the latest saved records.</p>
            <p data-status role="status" aria-live="polite"></p>
            <div data-output hidden><p><a data-download>Download PDF</a><span>Open the downloaded PDF to print or share the report.</span></p>
            <iframe data-preview title="Generated operational PDF report"></iframe></div>
        </div>`;
        document.body.appendChild(dialog); document.body.classList.add('ue-operational-report-open');
        const form = dialog.querySelector('form'), status = dialog.querySelector('[data-status]');
        form.elements.type.value = type; form.elements.month.value = today.slice(0, 7);
        form.elements.from.value = today.slice(0, 8) + '01'; form.elements.to.value = today;
        function updatePeriod() {
            const monthly = form.elements.period.value === 'month';
            form.classList.toggle('ue-report-custom-dates', !monthly);
            form.querySelector('[data-month]').hidden = !monthly;
            form.elements.month.required = monthly;
            form.querySelectorAll('[data-custom]').forEach(label => { label.hidden = monthly; });
            form.elements.from.required = form.elements.to.required = !monthly;
        }
        dialog.querySelector('[data-close]').addEventListener('click', close);
        form.addEventListener('change', () => {
            updatePeriod();
            controller?.abort(); controller = null;
            form.querySelector('[type=submit]').disabled = false;
            clearOutput(); status.textContent = 'Generate the report to apply these selections.';
        });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!form.reportValidity()) return;
            controller?.abort(); clearOutput();
            const request = new AbortController(); controller = request;
            const selected = Object.fromEntries(new FormData(form));
            if (selected.period === 'month') {
                const [year, month] = selected.month.split('-').map(Number);
                selected.from = selected.month + '-01';
                selected.to = selected.month + '-' + new Date(Date.UTC(year, month, 0)).getUTCDate();
            }
            const button = form.querySelector('[type=submit]'); button.disabled = true;
            status.textContent = 'Generating report…';
            try {
                const query = new URLSearchParams({ from: selected.from, to: selected.to });
                const response = await fetch(`${window.UE_API_URL}/reports/${selected.type}.pdf?${query}`, {
                    headers: authenticatedApiHeaders(), signal: request.signal
                });
                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    throw new Error(error.error || 'Unable to generate the report. Please try again.');
                }
                const blob = await response.blob();
                if (request.signal.aborted || !dialog) return;
                objectUrl = URL.createObjectURL(blob);
                const download = dialog.querySelector('[data-download]');
                download.href = objectUrl;
                download.download = `ultimate-express-${selected.type}-${selected.from}-to-${selected.to}.pdf`;
                dialog.querySelector('[data-preview]').src = objectUrl;
                dialog.querySelector('[data-output]').hidden = false;
                status.textContent = `${titles[selected.type]} generated for ${selected.from} to ${selected.to}.`;
            } catch (error) {
                if (!request.signal.aborted && dialog) status.textContent = error.message;
            } finally {
                if (controller === request) { button.disabled = false; controller = null; }
            }
        });
        keyHandler = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
            if (event.key !== 'Tab') return;
            const controls = [...dialog.querySelectorAll('button:not(:disabled),input,select,a[href],iframe')].filter(el => !el.closest('[hidden]'));
            const first = controls[0], last = controls.at(-1);
            if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', keyHandler);
        form.elements.type.focus();
    }
    window.UEOperationalReports = { open, close };
})();

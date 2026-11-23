(() => {
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const money = value => value == null ? 'Not recorded' : new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value));
    let previousFocus;
    function close() {
        document.getElementById('ueDocumentPreview')?.remove();
        document.body.classList.remove('ue-document-open', 'ue-document-printing');
        previousFocus?.focus();
    }
    function preview({ title, reference = '', facts = [], sections = [], note = '', content = '', landscape = false }) {
        close();
        previousFocus = document.activeElement;
        const root = document.createElement('section');
        root.id = 'ueDocumentPreview';
        if (landscape) root.classList.add('ue-document-landscape');
        root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', title);
        root.innerHTML = `<div class="ue-document-toolbar"><strong>${escape(title)}</strong><div><button type="button" data-print>Print / Save as PDF</button>
            <button type="button" data-close>Close preview</button></div></div><article class="ue-document-sheet">
            <header class="ue-document-brand"><img src="images/logo.jpg" alt="Ultimate Express logo"><div><strong>ULTIMATE EXPRESS</strong>
            <p>Trans Logistic Corporation</p></div></header><h1>${escape(title)}</h1>
            <p class="ue-document-reference">${escape(reference)}${reference ? ' · ' : ''}Generated ${escape(new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' }))} PHT</p>
            ${facts.length ? `<dl class="ue-document-facts">${facts.map(([label,value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value ?? 'Not provided')}</dd></div>`).join('')}</dl>` : ''}
            ${content}
            ${sections.map(section => `<section class="ue-document-section"><h2>${escape(section.title)}</h2><table><thead><tr>${section.columns.map(label => `<th scope="col">${escape(label)}</th>`).join('')}</tr></thead>
                <tbody>${section.rows.length ? section.rows.map(row => `<tr>${row.map(value => `<td>${escape(value ?? 'Not recorded')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${section.columns.length}">No records for this report.</td></tr>`}</tbody></table></section>`).join('')}
            ${note ? `<p class="ue-document-note">${escape(note)}</p>` : ''}
            <footer class="ue-document-footer">Ultimate Express · ${escape(title)}${reference ? ' · ' + escape(reference) : ''}</footer></article>`;
        root.querySelector('[data-close]').addEventListener('click', close);
        root.querySelector('[data-print]').addEventListener('click', () => {
            document.body.classList.add('ue-document-printing');
            const cleanup = () => document.body.classList.remove('ue-document-printing');
            window.addEventListener('afterprint', cleanup, { once: true });
            try { window.print(); }
            catch (error) { cleanup(); throw error; }
            // Some browsers return before their print UI closes; retain print styling until afterprint.
            setTimeout(cleanup, 60000);
        });
        document.body.appendChild(root); document.body.classList.add('ue-document-open');
        root.querySelector('[data-print]').focus();
    }
    // The existing receipt content is already constructed from escaped database values.
    function receiptElement(element, title = 'Service Receipt') {
        if (!element) return;
        const clone = element.cloneNode(true);
        clone.querySelectorAll('script,iframe,button').forEach(node => node.remove());
        preview({ title, content: clone.innerHTML, note: 'This is a system-generated service record. Payment is confirmed only when a paid amount and payment date are recorded.' });
    }
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.getElementById('ueDocumentPreview')) close(); });
    window.UEDocuments = { preview, receiptElement, money };
})();

(function () {
    window.UE = window.UE || {};
    const MAX_BYTES = 5 * 1024 * 1024;

    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        return node;
    }

    window.UE.Waybills = {
        mount(container, requestId, { canUpload = false } = {}) {
            const panel = element('section', '', 'waybill-panel');
            panel.append(element('h3', 'Waybills'));
            panel.append(element('p', canUpload
                ? 'Submit waybills for this booking. The customer can view and download them.'
                : 'View and download waybills submitted by the dispatch team.'));
            const status = element('p', '', 'waybill-status');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const list = element('ul', '', 'waybill-files');
            const endpoint = `${window.UE_API_URL}/service-requests/${encodeURIComponent(requestId)}/waybills`;
            let uploading = false;
            let input, submit;

            function message(text, error = false) {
                status.textContent = text;
                status.classList.toggle('error', error);
            }

            async function checked(response) {
                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.error || 'The waybill request failed. Please try again.');
                }
                return response;
            }

            async function openFile(file, download) {
                // Open the window during the click so browsers allow the PDF/image preview.
                const preview = download ? null : window.open('about:blank', '_blank');
                if (!download && !preview) {
                    message('Allow a new tab to view this waybill, or choose Download.', true);
                    return;
                }
                if (preview) { preview.opener = null; preview.document.title = 'Opening waybill...'; }
                try {
                    const response = await checked(await fetch(`${endpoint}/${file.id}${download ? '?download=1' : ''}`, {
                        headers: authenticatedApiHeaders(), cache: 'no-store'
                    }));
                    const url = URL.createObjectURL(await response.blob());
                    if (preview) preview.location.replace(url);
                    else {
                        const link = element('a');
                        link.href = url;
                        link.download = file.filename;
                        document.body.append(link);
                        link.click();
                        link.remove();
                    }
                    setTimeout(() => URL.revokeObjectURL(url), 60_000);
                    message('');
                } catch (error) {
                    if (preview) preview.close();
                    message(error.message || 'Unable to open the waybill.', true);
                }
            }

            async function refresh() {
                message('Loading waybills...');
                const response = await checked(await fetch(endpoint, { headers: authenticatedApiHeaders(), cache: 'no-store' }));
                const files = await response.json();
                list.replaceChildren();
                for (const file of files) {
                    const row = element('li', '', 'waybill-file');
                    row.append(element('strong', file.filename));
                    const date = file.created_at ? new Date(file.created_at).toLocaleString('en-PH') : '';
                    row.append(element('small', `${Math.max(1, Math.ceil(file.byte_size / 1024))} KB${date ? ' · ' + date : ''}`));
                    for (const [label, download] of [['View', false], ['Download', true]]) {
                        const button = element('button', label);
                        button.type = 'button';
                        button.setAttribute('aria-label', `${label} ${file.filename}`);
                        button.addEventListener('click', () => openFile(file, download));
                        row.append(button);
                    }
                    list.append(row);
                }
                message(files.length ? `${files.length} waybill${files.length === 1 ? '' : 's'} attached.` : 'No waybills have been submitted yet.');
                return files.length;
            }

            if (canUpload) {
                const drop = element('div', '', 'waybill-drop');
                const label = element('label', 'Drop a waybill here or choose a file');
                input = element('input');
                input.type = 'file';
                input.accept = '.pdf,.jpg,.jpeg,.png';
                label.append(input);
                submit = element('button', 'Upload waybill');
                submit.type = 'button';
                drop.append(label, element('p', 'PDF, JPG, or PNG · Up to 5 MB per file · 10 files per booking'), submit);
                panel.append(drop);

                async function upload(file) {
                    if (uploading) return;
                    if (!file) return message('Choose a waybill file first.', true);
                    if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) return message('Choose a PDF, JPG, or PNG file.', true);
                    if (!file.size || file.size > MAX_BYTES) return message('Choose a nonempty file that is 5 MB or smaller.', true);
                    uploading = true;
                    input.disabled = submit.disabled = true;
                    message('Uploading waybill...');
                    try {
                        await checked(await fetch(endpoint, {
                            method: 'POST',
                            headers: authenticatedApiHeaders({ 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }),
                            body: file
                        }));
                        input.value = '';
                        await refresh();
                        message('Waybill uploaded. The customer can now view and download it.');
                    } catch (error) {
                        message(error.message || 'Unable to upload the waybill.', true);
                    } finally {
                        uploading = false;
                        input.disabled = submit.disabled = false;
                    }
                }

                submit.addEventListener('click', () => upload(input.files[0]));
                drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
                drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
                drop.addEventListener('drop', event => {
                    event.preventDefault();
                    drop.classList.remove('dragging');
                    if (event.dataTransfer.files.length !== 1) return message('Drop one waybill at a time.', true);
                    upload(event.dataTransfer.files[0]);
                });
            }
            const reload = element('button', 'Refresh waybills');
            reload.type = 'button';
            reload.addEventListener('click', () => refresh().catch(error => message(error.message, true)));
            panel.append(status, reload, list);
            container.replaceChildren(panel);
            refresh().catch(error => message(error.message || 'Unable to load waybills.', true));
        }
    };
})();

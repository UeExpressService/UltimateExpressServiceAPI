/* ue-dialog.js - Ultimate Express styled alert / confirm boxes.
 *
 *   await UE.alert('Saved!', { type: 'success', title: 'Done' });
 *   if (await UE.confirm('Delete this driver?', { type: 'danger', confirmText: 'Delete' })) { ... }
 *
 * It also replaces the plain browser window.alert(), so any leftover alert() looks the same.
 * confirm() cannot be replaced automatically (it must be "awaited"), so use UE.confirm().
 */
(function () {
    window.UE = window.UE || {};
    if (window.UE.dialog) return;

    const ICONS = {
        success: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
        error: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        warning: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>',
        info: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".6" fill="currentColor"/></svg>',
        question: '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9a3 3 0 1 1 4.6 2.5c-1 .7-1.6 1.2-1.6 2.5"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/></svg>'
    };
    ICONS.danger = ICONS.warning;

    const DEFAULT_TITLES = {
        success: 'Success',
        error: 'Something went wrong',
        warning: 'Please check',
        info: 'Notice',
        question: 'Please confirm',
        danger: 'Please confirm'
    };

    const queue = [];
    let busy = false;

    function show(config) {
        return new Promise(resolve => {
            queue.push({ config, resolve });
            if (!busy) next();
        });
    }

    function next() {
        const item = queue.shift();
        if (!item) { busy = false; return; }
        busy = true;
        if (document.body) render(item); else document.addEventListener('DOMContentLoaded', () => render(item), { once: true });
    }

    function render({ config, resolve }) {
        const type = ICONS[config.type] ? config.type : 'info';
        const previouslyFocused = document.activeElement;
        const uid = 'ue-dlg-' + Math.random().toString(36).slice(2, 8);

        const backdrop = document.createElement('div');
        backdrop.className = 'ue-dlg-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'ue-dlg';
        dialog.setAttribute('role', config.confirm ? 'alertdialog' : 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', uid + '-title');
        dialog.setAttribute('aria-describedby', uid + '-message');

        const icon = document.createElement('div');
        icon.className = 'ue-dlg-icon ' + type;
        icon.innerHTML = ICONS[type];

        const title = document.createElement('h3');
        title.className = 'ue-dlg-title';
        title.id = uid + '-title';
        title.textContent = config.title || DEFAULT_TITLES[type];

        const message = document.createElement('p');
        message.className = 'ue-dlg-message';
        message.id = uid + '-message';
        message.textContent = String(config.message ?? '');

        const actions = document.createElement('div');
        actions.className = 'ue-dlg-actions';

        let cancelButton = null;
        if (config.confirm) {
            cancelButton = document.createElement('button');
            cancelButton.type = 'button';
            cancelButton.className = 'ue-dlg-btn secondary';
            cancelButton.textContent = config.cancelText || 'Cancel';
            actions.appendChild(cancelButton);
        }
        const okButton = document.createElement('button');
        okButton.type = 'button';
        okButton.className = 'ue-dlg-btn ' + (type === 'danger' || type === 'error' && config.confirm ? 'danger' : 'primary');
        okButton.textContent = config.confirmText || (config.confirm ? 'Confirm' : 'OK');
        actions.appendChild(okButton);

        dialog.append(icon, title, message, actions);
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
        requestAnimationFrame(() => backdrop.classList.add('ue-show'));

        let closed = false;
        function close(result) {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey, true);
            backdrop.classList.remove('ue-show');
            setTimeout(() => {
                backdrop.remove();
                if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                    try { previouslyFocused.focus(); } catch { /* ignore */ }
                }
                resolve(result);
                next();
            }, 160);
        }

        function onKey(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(false);
            } else if (event.key === 'Tab') {
                const buttons = [cancelButton, okButton].filter(Boolean);
                const index = buttons.indexOf(document.activeElement);
                event.preventDefault();
                const step = event.shiftKey ? -1 : 1;
                buttons[(index + step + buttons.length) % buttons.length].focus();
            }
        }
        document.addEventListener('keydown', onKey, true);

        okButton.addEventListener('click', () => close(true));
        if (cancelButton) cancelButton.addEventListener('click', () => close(false));
        backdrop.addEventListener('mousedown', event => {
            if (event.target === backdrop) close(false);
        });

        // For destructive questions the safe button is focused first, so a stray Enter does not delete.
        (config.confirm && type === 'danger' ? cancelButton : okButton).focus();
    }

    window.UE.dialog = {
        alert(message, options = {}) {
            return show({ message, confirm: false, type: options.type || 'info', title: options.title, confirmText: options.okText || options.confirmText }).then(() => undefined);
        },
        confirm(message, options = {}) {
            return show({
                message,
                confirm: true,
                type: options.type || 'question',
                title: options.title,
                confirmText: options.confirmText,
                cancelText: options.cancelText
            });
        }
    };
    window.UE.alert = window.UE.dialog.alert;
    window.UE.confirm = window.UE.dialog.confirm;

    // Any plain alert() left in the pages now uses the styled box too.
    window.alert = function (message) {
        const text = String(message ?? '');
        const type = /unable|failed|error|could not|cannot|invalid|wrong/i.test(text) ? 'error'
            : /please|required|missing|must/i.test(text) ? 'warning'
            : /thank|success|saved|submitted|created|sent/i.test(text) ? 'success'
            : 'info';
        window.UE.dialog.alert(text, { type });
    };
})();

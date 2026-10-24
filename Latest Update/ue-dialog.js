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

    const STYLE = `
.ue-dlg-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(20,28,16,.55);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);opacity:0;transition:opacity .18s ease}
.ue-dlg-backdrop.ue-show{opacity:1}
.ue-dlg{box-sizing:border-box;width:100%;max-width:420px;max-height:90vh;overflow-y:auto;padding:1.75rem 1.5rem 1.25rem;border-radius:22px;background:#fff;color:#2d3a24;text-align:center;font-family:'Poppins',system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.35);transform:translateY(14px) scale(.96);transition:transform .22s cubic-bezier(.2,.9,.3,1.2)}
.ue-dlg-backdrop.ue-show .ue-dlg{transform:none}
.ue-dlg-icon{width:68px;height:68px;margin:0 auto 1rem;border-radius:50%;display:flex;align-items:center;justify-content:center}
.ue-dlg-icon.success{background:#dcfce7;color:#28a745}
.ue-dlg-icon.error,.ue-dlg-icon.danger{background:#fee2e2;color:#dc2626}
.ue-dlg-icon.warning{background:#fef3c7;color:#f59e0b}
.ue-dlg-icon.info{background:#e0f2fe;color:#0369a1}
.ue-dlg-icon.question{background:#fff1e7;color:#e07b39}
.ue-dlg-title{margin:0 0 .45rem;font-size:1.15rem;font-weight:700;line-height:1.3;color:#2d3a24}
.ue-dlg-message{margin:0;font-size:.92rem;line-height:1.6;color:#6c757d;white-space:pre-line;overflow-wrap:anywhere}
.ue-dlg-actions{display:flex;gap:.75rem;margin-top:1.5rem}
.ue-dlg-btn{flex:1;padding:.8rem 1rem;border:2px solid transparent;border-radius:12px;font:600 .9rem 'Poppins',system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer;transition:background .2s,transform .15s,box-shadow .2s}
.ue-dlg-btn:hover{transform:translateY(-1px)}
.ue-dlg-btn:focus-visible{outline:3px solid rgba(224,123,57,.45);outline-offset:2px}
.ue-dlg-btn.primary{background:#e07b39;color:#fff;box-shadow:0 6px 16px rgba(224,123,57,.3)}
.ue-dlg-btn.primary:hover{background:#c4652c}
.ue-dlg-btn.danger{background:#dc2626;color:#fff;box-shadow:0 6px 16px rgba(220,38,38,.28)}
.ue-dlg-btn.danger:hover{background:#b91c1c}
.ue-dlg-btn.secondary{background:#fff;color:#4a5d3a;border-color:#4a5d3a}
.ue-dlg-btn.secondary:hover{background:#4a5d3a;color:#fff}
@media (max-width:420px){.ue-dlg-actions{flex-direction:column-reverse}}
@media (prefers-reduced-motion:reduce){.ue-dlg-backdrop,.ue-dlg,.ue-dlg-btn{transition:none}}
`;

    let styleAdded = false;
    const queue = [];
    let busy = false;

    function addStyle() {
        if (styleAdded) return;
        const style = document.createElement('style');
        style.setAttribute('data-ue-dialog', '');
        style.textContent = STYLE;
        document.head.appendChild(style);
        styleAdded = true;
    }

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
        addStyle();
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

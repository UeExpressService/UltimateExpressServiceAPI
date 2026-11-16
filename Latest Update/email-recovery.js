(() => {
    const button = document.getElementById('gmailReconnect');
    const status = document.getElementById('gmailRecoveryStatus');
    const messages = {
        connected: 'Company Gmail is reconnected. Return to sign in and request a new login code.',
        'wrong-account': 'No changes were saved. Only the configured company Gmail owner can reconnect this service.',
        expired: 'This recovery session expired or was already used. Start again using the button below.',
        cancelled: 'Google authorization was not completed. You can start again when ready.',
        permission: 'Gmail-send permission was not granted. Review the requested permission with the company owner.',
        unavailable: 'The connection could not be saved. Please contact the website administrator or try again.'
    };
    const show = (message, success = false) => {
        status.textContent = message;
        status.hidden = false;
        status.classList.toggle('is-success', success);
    };
    const result = new URLSearchParams(location.search).get('result');
    if (messages[result]) show(messages[result], result === 'connected');
    button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Opening Google...';
        try {
            const response = await fetch('/api/admin/gmail/reconnect', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not start email recovery.');
            const url = new URL(data.authorizationUrl);
            if (url.origin !== 'https://accounts.google.com') throw new Error('Could not open Google authorization.');
            location.assign(url.href);
        } catch (error) {
            show(error.message || 'Could not start email recovery. Please try again.');
            button.disabled = false;
            button.textContent = 'Reconnect company Gmail';
        }
    });
})();

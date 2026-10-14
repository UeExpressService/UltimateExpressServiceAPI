(function configureApiUrl() {
    const API_URL_OVERRIDE = '';
    const override = API_URL_OVERRIDE.trim();
    if (override) {
        window.UE_API_URL = override.replace(/\/+$/, '');
        return;
    }
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const hostname = window.location.hostname || 'localhost';
    if (protocol === 'https:' && window.location.hostname) {
        window.UE_API_URL = `${window.location.origin}/api`;
        return;
    }
    window.UE_API_URL = `${protocol}//${hostname}:3000/api`;
})();

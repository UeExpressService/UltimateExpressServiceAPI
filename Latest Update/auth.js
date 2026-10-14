// auth.js - Updated for backend API

// Role definitions (kept for reference)
const ROLES = {
    CUSTOMER: 'customer',
    DISPATCHER: 'dispatcher',
    SUPERVISOR: 'supervisor',
    MANAGER: 'manager'
};

// ------------------------------------------------------------------
// Helper functions
// ------------------------------------------------------------------

function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

function showError(elementId, message) {
    const el = document.getElementById(elementId) || document.getElementById('loginError');
    if (el) {
        el.innerText = message;
        el.style.display = 'block';
    }
}

function showSuccess(message) {
    const el = document.getElementById('successMessage');
    if (el) {
        el.innerText = message;
        el.style.display = 'block';
    }
}

function clearErrors() {
    document.querySelectorAll('.error-message').forEach(el => {
        el.innerText = '';
        el.style.display = 'none';
    });
    const success = document.querySelector('.success-message');
    if (success) success.style.display = 'none';
}

function checkPasswordStrength(value) {
    const bar = document.getElementById('passwordStrengthBar');
    if (!bar) return;
    let strength = 0;
    if (value.length >= 6) strength++;
    if (/[A-Z]/.test(value)) strength++;
    if (/[0-9]/.test(value)) strength++;
    if (/[^A-Za-z0-9]/.test(value)) strength++;
    const percent = (strength / 4) * 100;
    bar.style.width = percent + '%';
    bar.className = 'password-strength-bar';
    if (strength <= 1) bar.classList.add('strength-weak');
    else if (strength === 2) bar.classList.add('strength-medium');
    else bar.classList.add('strength-strong');
}

function redirectToProperDashboard(role) {
    const dashboards = {
        'customer': 'Customer.html',
        'dispatcher': 'Dispatcher.html',
        'supervisor': 'Supervisor.html',
        'manager': 'Manager.html'
    };
    window.location.href = dashboards[role] || 'LandingPage.html';
}

function getCurrentUser() {
    try {
        return JSON.parse(sessionStorage.getItem('currentUser') || 'null');
    } catch (error) {
        sessionStorage.removeItem('currentUser');
        return null;
    }
}

function authenticatedApiHeaders(headers = {}) {
    const currentUser = getCurrentUser();
    return currentUser && currentUser.authToken
        ? { ...headers, Authorization: `Bearer ${currentUser.authToken}` }
        : { ...headers };
}

function hasAuthenticatedSession(currentUser) {
    const loginTime = currentUser ? Date.parse(currentUser.loginTime) : NaN;
    return Boolean(
        currentUser &&
        currentUser.mfaAuthenticated === true &&
        Number.isFinite(loginTime) &&
        Date.now() >= loginTime &&
        Date.now() - loginTime < 8 * 60 * 60 * 1000
    );
}

function requireRole(requiredRole) {
    const currentUser = getCurrentUser();
    if (!hasAuthenticatedSession(currentUser) || currentUser.mustChangePassword === true || currentUser.role !== requiredRole) {
        sessionStorage.removeItem('currentUser');
        window.location.replace('login.html');
        return false;
    }
    return true;
}

function handleLogout() {
    sessionStorage.removeItem('currentUser');
}

function updateDashboardIdentity() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    const roleLabels = {
        customer: 'Customer',
        dispatcher: 'Dispatcher',
        supervisor: 'Supervisor',
        manager: 'Manager'
    };
    const nameElement = document.querySelector('.user-info .name');
    const roleElement = document.querySelector('.user-info .role');
    if (nameElement) nameElement.textContent = currentUser.name || currentUser.email;
    if (roleElement) roleElement.textContent = roleLabels[currentUser.role] || currentUser.role;
}

// Check if user is already logged in
function checkExistingSession() {
    const currentUser = getCurrentUser();
    if (hasAuthenticatedSession(currentUser) && currentUser.role) {
        if (currentUser.mustChangePassword === true) {
            showFirstLoginPasswordSetup();
            return;
        }
        redirectToProperDashboard(currentUser.role);
    } else {
        sessionStorage.removeItem('currentUser');
    }
}

// ------------------------------------------------------------------
// Login handler (uses backend API)
// ------------------------------------------------------------------
let loginChallengeId = '';

function setLoginRequestPending(pending) {
    const submit = document.getElementById('loginSubmitBtn');
    if (submit) {
        submit.disabled = pending;
        submit.textContent = pending ? 'Sending code...' : 'Continue';
    }
}

function setCodeVerificationPending(pending) {
    const submit = document.getElementById('verifyCodeBtn');
    if (submit) {
        submit.disabled = pending;
        submit.textContent = pending ? 'Verifying...' : 'Verify and log in';
    }
}

function showFirstLoginPasswordSetup() {
    document.getElementById('loginForm').hidden = true;
    document.getElementById('verificationForm').hidden = true;
    document.getElementById('firstLoginPasswordStep').hidden = false;
    document.querySelector('.form-footer').hidden = true;
    document.getElementById('firstLoginPassword').focus();
}

function resetLoginVerification() {
    loginChallengeId = '';
    document.getElementById('verificationForm').hidden = true;
    document.getElementById('passwordStep').hidden = false;
    document.getElementById('loginCode').value = '';
    document.getElementById('loginPassword').value = '';
    clearErrors();
    document.getElementById('loginPassword').focus();
}

function completeLogin(data) {
    const userSession = {
        id: data.id,
        name: data.name,
        email: data.email,
        company: data.company || '',
        phone: data.phone || '',
        role: data.role,
        authToken: data.authToken || '',
        mustChangePassword: data.mustChangePassword === true,
        mfaAuthenticated: true,
        loginTime: new Date().toISOString()
    };
    sessionStorage.setItem('currentUser', JSON.stringify(userSession));
    if (userSession.mustChangePassword) {
        showFirstLoginPasswordSetup();
        return;
    }
    showSuccess(`Welcome back, ${userSession.name}! Redirecting...`);
    setTimeout(() => redirectToProperDashboard(userSession.role), 1200);
}

async function handleFirstLoginPasswordChange(event) {
    event.preventDefault();
    const password = document.getElementById('firstLoginPassword').value;
    const confirmPassword = document.getElementById('firstLoginConfirmPassword').value;
    const errorElement = document.getElementById('firstLoginPasswordError');
    errorElement.style.display = 'none';
    errorElement.textContent = '';
    if (password.length < 12 || password.length > 128) {
        errorElement.textContent = 'Use a password between 12 and 128 characters.';
        errorElement.style.display = 'block';
        return;
    }
    if (password !== confirmPassword) {
        errorElement.textContent = 'The passwords do not match.';
        errorElement.style.display = 'block';
        return;
    }

    const button = document.getElementById('firstLoginPasswordBtn');
    button.disabled = true;
    button.textContent = 'Saving password...';
    try {
        const response = await fetch(`${window.UE_API_URL}/account/first-login-password`, {
            method: 'POST',
            headers: authenticatedApiHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ password, confirmPassword })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to save your password.');
        const user = getCurrentUser();
        if (!user) throw new Error('Your session expired. Sign in again.');
        user.authToken = data.authToken;
        user.mustChangePassword = false;
        sessionStorage.setItem('currentUser', JSON.stringify(user));
        showSuccess('Password saved. Redirecting to your dashboard...');
        setTimeout(() => redirectToProperDashboard(user.role), 1000);
    } catch (error) {
        console.error('First-login password setup failed:', error);
        errorElement.textContent = error.message || 'Unable to save your password. Please try again.';
        errorElement.style.display = 'block';
    } finally {
        button.disabled = false;
        button.textContent = 'Save password and continue';
    }
}

async function handleLogin(event) {
    event.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    clearErrors();
    if (!email || !validateEmail(email)) {
        showError('loginEmailError', 'Please enter a valid email address');
        return;
    }
    if (!password) {
        showError('loginPasswordError', 'Please enter your password');
        return;
    }

    setLoginRequestPending(true);
    try {
        const response = await fetch(`${window.UE_API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await response.json();
        if (!response.ok) {
            showError('loginPasswordError', data.error || 'Unable to start login verification.');
            return;
        }
        loginChallengeId = data.challengeId;
        document.getElementById('passwordStep').hidden = true;
        document.getElementById('verificationForm').hidden = false;
        document.getElementById('verificationMessage').textContent =
            `We sent a six-digit code to ${data.maskedEmail}. The code expires in 10 minutes.`;
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginCode').focus();
    } catch (error) {
        console.error('Login error:', error);
        showError('loginPasswordError', 'Unable to contact the login service. Check that the backend server is running.');
    } finally {
        setLoginRequestPending(false);
    }
}

async function handleCodeVerification(event) {
    event.preventDefault();
    clearErrors();
    const code = document.getElementById('loginCode').value.trim();
    if (!loginChallengeId) {
        showError('loginCodeError', 'Start login again to request a new code.');
        return;
    }
    if (!/^\d{6}$/.test(code)) {
        showError('loginCodeError', 'Enter the six-digit code from your email.');
        return;
    }

    setCodeVerificationPending(true);
    try {
        const response = await fetch(`${window.UE_API_URL}/login/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId: loginChallengeId, code })
        });
        const data = await response.json();
        if (!response.ok) {
            showError('loginCodeError', data.error || 'Unable to verify this code.');
            return;
        }
        completeLogin(data);
    } catch (error) {
        console.error('Login code verification error:', error);
        showError('loginCodeError', 'Unable to contact the login service. Check that the backend server is running.');
    } finally {
        setCodeVerificationPending(false);
    }
}

// ------------------------------------------------------------------
// Initialization: check session on page load
// ------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', function() {
    updateDashboardIdentity();
    // Only check session if we are on the login page
    // (so it doesn't interfere with dashboards)
    const path = window.location.pathname;
    if (path.includes('login.html') && new URLSearchParams(window.location.search).get('logout') === '1') {
        handleLogout();
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    if (path.includes('login.html')) {
        checkExistingSession();
    }
});
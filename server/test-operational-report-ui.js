// Optional browser checks against the isolated local MySQL test server.
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function ({ base, sessions, output }) {
    const { chromium } = require(process.env.UE_REPORT_BROWSER_QA);
    const browser = await chromium.launch({ headless: true, ...(process.env.UE_BROWSER_EXECUTABLE ? { executablePath: process.env.UE_BROWSER_EXECUTABLE } : {}) });
    const origin = new URL(base).origin;
    async function pageFor(role) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.protocol === 'blob:') return route.continue();
            if (url.origin !== origin) return route.abort();
            if (url.pathname === '/api-config.js') return route.fulfill({ contentType: 'text/javascript', body: `window.UE_API_URL=${JSON.stringify(base)};` });
            return route.continue();
        });
        await context.addInitScript(({ role, token }) => {
            window.Chart = class { constructor(element, config) { Object.assign(this, config); } update() {} destroy() {} };
            sessionStorage.setItem('currentUser', JSON.stringify({ id: role === 'manager' ? 2 : 5, role, name: 'Local QA ' + role,
                email: role + '@example.invalid', mfaAuthenticated: true, authToken: token, loginTime: new Date().toISOString() }));
        }, { role, token: sessions[role] });
        const page = await context.newPage();
        page.on('pageerror', error => console.error('Report UI error: ' + error.message));
        page.setDefaultTimeout(15000);
        await page.goto(origin + '/' + (role === 'manager' ? 'Manager.html' : 'Supervisor.html'));
        return page;
    }
    try {
        const manager = await pageFor('manager');
        await manager.locator('[onclick="showPanel(\'revenue\')"]').click();
        await manager.getByRole('button', { name: 'Generate Monthly Report' }).click();
        assert.equal(await manager.locator('.ue-operational-report-dialog').count(), 1, 'Report generator opens after clicking its entry point');
        const dialog = manager.getByRole('dialog');
        assert.equal(await dialog.locator('[name=type]').inputValue(), 'payments');
        assert.equal(await dialog.locator('[name=period]').inputValue(), 'month');
        await dialog.locator('[name=month]').fill('2035-01');
        const responsePromise = manager.waitForResponse(response => response.url().includes('/reports/payments.pdf'));
        await dialog.getByRole('button', { name: 'Generate PDF' }).click();
        const response = await responsePromise;
        assert.equal(response.status(), 200);
        assert.match(response.url(), /from=2035-01-01&to=2035-01-31$/);
        await dialog.getByRole('link', { name: 'Download PDF' }).waitFor();
        assert.equal(await dialog.locator('[data-download]').getAttribute('download'), 'ultimate-express-payments-2035-01-01-to-2035-01-31.pdf');
        assert.match(await dialog.locator('iframe').getAttribute('src'), /^blob:/);
        await manager.screenshot({ path: path.join(output, 'manager-monthly-report.png') });

        await dialog.locator('[name=month]').fill('2024-02');
        assert.equal(await dialog.locator('[data-output]').isVisible(), false, 'Changing filters clears the old PDF');
        const leapResponse = manager.waitForResponse(response => response.url().includes('/reports/payments.pdf'));
        await dialog.getByRole('button', { name: 'Generate PDF' }).click();
        assert.match((await leapResponse).url(), /from=2024-02-01&to=2024-02-29$/);
        await dialog.getByRole('link', { name: 'Download PDF' }).waitFor();

        await dialog.locator('[name=period]').selectOption('custom');
        await dialog.locator('[name=from]').fill('2035-02-01');
        await dialog.locator('[name=to]').fill('2035-01-01');
        await dialog.getByRole('button', { name: 'Generate PDF' }).click();
        await dialog.getByText('Choose a period of 1 to 366 days, with From on or before To.', { exact: true }).waitFor();
        assert.equal(await dialog.locator('[data-output]').isVisible(), false);

        await manager.setViewportSize({ width: 390, height: 844 });
        assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false, 'The report controls fit mobile screens');
        await manager.screenshot({ path: path.join(output, 'report-controls-mobile.png') });
        await manager.keyboard.press('Escape');
        assert.equal(await manager.getByRole('dialog').count(), 0);

        const supervisor = await pageFor('supervisor');
        await supervisor.getByRole('button', { name: 'Generate Activity Report' }).click();
        const fleet = supervisor.getByRole('dialog');
        assert.equal(await fleet.locator('[name=type]').inputValue(), 'driverlist');
        assert.deepEqual(await fleet.locator('[name=type] option').evaluateAll(options => options.map(option => option.value)), ['bookings','driverlist','trucklist','drivers','newdrivers','newtrucks','customertrucks']);
        assert.equal(await fleet.locator('option[value=payments]').count(), 0, 'Supervisors cannot choose financial reports');
        await fleet.locator('[name=month]').fill('2035-01');
        await fleet.getByRole('button', { name: 'Generate PDF' }).click();
        await fleet.getByRole('link', { name: 'Download PDF' }).waitFor();
        assert.match(await fleet.locator('[data-download]').getAttribute('download'), /driverlist-2035-01-01-to-2035-01-31/);
        await supervisor.screenshot({ path: path.join(output, 'supervisor-activity-report.png') });
        console.log('Monthly report browser checks passed: Manager and Supervisor entry points, PDF preview/download, exact month and leap-year boundaries, stale-preview clearing, validation errors and mobile layout.');
    } finally { await browser.close(); }
};

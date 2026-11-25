const ROLES = ['customer', 'dispatcher', 'supervisor', 'manager'];
const COLUMNS = {
    actor_name: 'VARCHAR(255) NULL', actor_email: 'VARCHAR(255) NULL', actor_role: 'VARCHAR(32) NULL',
    outcome: "VARCHAR(16) NOT NULL DEFAULT 'success'", http_status: 'SMALLINT UNSIGNED NULL',
    source: "VARCHAR(16) NOT NULL DEFAULT 'server'"
};
const UI_ACTIONS = {
    'page.opened': 'Opened their dashboard', 'section.opened': 'Opened a dashboard section',
    'filter.changed': 'Changed a list filter', 'search.used': 'Used list search',
    'report.export_requested': 'Requested a report export', 'receipt.opened': 'Opened a receipt', 'receipt.print_requested': 'Requested a receipt print',
    'route.open_requested': 'Requested route directions'
};
const SECTIONS = new Set(['dashboard', 'accounts', 'transactions', 'partners', 'audit', 'revenue', 'inquiries', 'website-inquiries', 'pricing', 'maintenance', 'drivers', 'trucks', 'history', 'profile', 'services', 'fleet', 'all', 'new', 'pending', 'approved', 'ongoing', 'completed', 'cancelled']);

function routeActivity(req) {
    const path = typeof req.route?.path === 'string' ? req.route.path : '';
    const method = req.method;
    const make = (action, type, summary, read = false) => ({ action, type, summary, read });
    if (path === '/api/login') return make('session.code_requested', 'user', 'Requested a sign-in code after password verification.');
    if (path === '/api/login/verify-code') return make('session.signed_in', 'user', 'Verified the sign-in code and signed in.');
    if (path === '/api/payment-schedules' || path === '/api/service-requests/:id/payment-schedule') return make(method === 'GET' ? 'payment_schedule.viewed' : 'payment_schedule.updated', 'payment_schedule', method === 'GET' ? 'Viewed scheduled payments.' : 'Updated a payment due date.', method === 'GET');
    if (path === '/api/logout') return make('session.signed_out', 'user', 'Signed out.');
    if (path === '/api/account/first-login-password') return make('password.changed', 'user', 'Set their account password.');
    if (path === '/api/customer/password-reset/confirm') return make('password.reset', 'user', 'Reset their account password.');
    if (path === '/api/manager/report') return make('report.viewed', 'report', 'Viewed management reports.', true);
    if (path === '/api/reports/:type.pdf') return make('report.generated', 'report', 'Generated a printable operational PDF report.');
    if (path.includes('/waybills')) return make(method === 'POST' ? 'waybill.uploaded' : path.includes(':waybillId') ? 'waybill.opened' : 'waybills.viewed', method === 'GET' && !path.includes(':waybillId') ? 'service_request' : 'waybill', method === 'POST' ? 'Uploaded a waybill.' : path.includes(':waybillId') ? 'Viewed or downloaded a waybill.' : 'Viewed the booking waybill list.', method === 'GET' && !path.includes(':waybillId'));
    if (path === '/api/service-requests/:id/payment') return make('payment.recorded', 'service_request', 'Recorded the service payment.');
    if (path === '/api/service-requests/:id/cancel') return make('service_request.cancelled', 'service_request', 'Cancelled a booking.');
    if (path === '/api/users/create-customer') return make('customer_account.created', 'user', 'Created a customer account.');
    if (path.startsWith('/api/website-inquiries')) return make(method === 'GET' ? 'website_inquiry.viewed' : 'website_inquiry.updated', 'website_inquiry', method === 'GET' ? 'Viewed website guest inquiries.' : 'Updated guest inquiry follow-up.', method === 'GET');
    if (path === '/api/route-estimates' || path.startsWith('/api/route-rates')) return make(method === 'GET' ? 'route_rates.viewed' : path === '/api/route-estimates' ? 'route_estimate.calculated' : 'route_rate.updated', 'route_rate', 'Accessed route pricing.', method === 'GET');
    if (path.startsWith('/api/maintenance-requests')) return make(method === 'GET' ? 'inspection_requests.viewed' : method === 'POST' ? 'inspection_request.created' : 'inspection_request.reviewed', 'truck_inspection', 'Accessed truck inspection requests.', method === 'GET');
    if (path === '/api/truck-maintenance' || path.includes('/maintenance')) return make(method === 'GET' ? 'maintenance.viewed' : 'maintenance.recorded', 'truck', 'Accessed truck maintenance.', method === 'GET');
    const resources = {
        '/api/trucks': ['truck', 'truck records'], '/api/trucks/:id': ['truck', 'a truck'],
        '/api/drivers': ['driver', 'driver records'], '/api/drivers/:id': ['driver', 'a driver'],
        '/api/service-requests': ['service_request', 'service requests'], '/api/service-requests/:id': ['service_request', 'a booking, quotation or assignment'],
        '/api/users': ['account', 'user accounts'], '/api/users/:id': ['account', 'an account profile'],
        '/api/partners': ['partner', 'business partners'], '/api/partners/:id': ['partner', 'a business partner'],
        '/api/customer-account-requests': ['customer_request', 'customer account inquiries'], '/api/customer-account-requests/:id': ['customer_request', 'a customer account inquiry']
    };
    const resource = resources[path];
    const operation = { GET: ['viewed', 'Viewed'], POST: ['created', 'Created'], PUT: ['updated', 'Updated'], PATCH: ['updated', 'Updated'], DELETE: ['deleted', 'Removed'] }[method];
    return resource && operation ? make(`${resource[0]}.${operation[0]}`, resource[0], `${operation[1]} ${resource[1]}.`, method === 'GET') : null;
}

function createAuditTrail({ dbp, now = Date.now, readWindowMs = 5 * 60_000 }) {
    let setup;
    const pending = new Set(), recentReads = new Map();
    async function ready() {
        if (!setup) setup = (async () => {
            await dbp.query(`CREATE TABLE IF NOT EXISTS manager_audit_logs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_user_id BIGINT UNSIGNED NULL,
                action VARCHAR(100) NOT NULL, entity_type VARCHAR(64) NOT NULL, entity_id VARCHAR(64) NULL,
                summary VARCHAR(500) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_manager_audit_created (created_at), INDEX idx_manager_audit_actor_created (actor_user_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
            const [columns] = await dbp.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='manager_audit_logs'");
            const existing = new Set(columns.map(c => c.COLUMN_NAME));
            for (const [name, type] of Object.entries(COLUMNS)) if (!existing.has(name)) {
                try { await dbp.query(`ALTER TABLE manager_audit_logs ADD COLUMN ${name} ${type}`); }
                catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
            }
            // Preserve the identity still available for older entries, without inventing past events.
            await dbp.query(`UPDATE manager_audit_logs log JOIN users account ON account.id=log.actor_user_id
                SET log.actor_name=COALESCE(log.actor_name,account.name),
                    log.actor_email=COALESCE(log.actor_email,account.email),
                    log.actor_role=COALESCE(log.actor_role,account.role)
                WHERE log.actor_name IS NULL OR log.actor_email IS NULL OR log.actor_role IS NULL`);
        })().catch(error => { setup = undefined; throw error; });
        return setup;
    }
    async function record(actor, activity, status, entityId, source = 'server', aborted = false) {
        await ready();
        let account;
        if (actor.id) {
            const [rows] = await dbp.execute('SELECT name, email, role FROM users WHERE id = ? LIMIT 1', [actor.id]);
            account = rows[0];
        }
        const role = account?.role || actor.role || null;
        const outcome = aborted ? 'aborted' : status === 401 || status === 403 || status === 429 ? 'denied' : status >= 400 ? 'failed' : 'success';
        const summary = outcome === 'success' ? activity.summary : `${outcome === 'denied' ? 'Blocked attempt' : outcome === 'aborted' ? 'Interrupted action' : 'Failed attempt'}: ${activity.summary}`;
        await dbp.execute(`INSERT INTO manager_audit_logs
            (actor_user_id, actor_name, actor_email, actor_role, action, entity_type, entity_id, summary, outcome, http_status, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [actor.id || null, account?.name || actor.name || `Former account ${actor.id}`, account?.email || actor.email || null, role,
            activity.action, activity.type, entityId == null ? null : String(entityId).slice(0, 64), summary.slice(0, 500), outcome, aborted ? null : status, source]);
    }
    function middleware(req, res, next) {
        let recorded = false;
        const finish = aborted => {
            if (recorded) return;
            recorded = true;
            const id = Number(req.auth?.sub ?? res.locals.auditActorUserId);
            let actor = Number.isSafeInteger(id) && id > 0 ? { id, role: req.auth?.role } : null;
            if (!actor && res.locals.auditExternalActor?.role === 'company_owner') actor = res.locals.auditExternalActor;
            if (!actor) return;
            let activity = res.locals.auditDescriptor || routeActivity(req) || (req.route?.path === '/api/manager/audit-logs' && res.statusCode >= 400 ? { action: 'audit.access_denied', type: 'audit', summary: 'Tried to open the user activity log.' } : null);
            if (!activity) return;
            if (res.locals.auditSummary) activity = { ...activity, summary: res.locals.auditSummary };
            const entityId = res.locals.auditEntityId ?? req.params.waybillId ?? req.params.id ?? (activity.type === 'user' ? actor.id : null);
            const source = res.locals.auditSource === 'interface' ? 'interface' : 'server';
            // Collapse identical read refreshes, never writes, failures, downloads or interface actions.
            if (activity.read && res.statusCode < 400 && !aborted) {
                const key = `${actor.id}:${activity.action}:${entityId || ''}:${req.query.year || ''}`;
                const last = recentReads.get(key);
                if (last !== undefined && now() - last < readWindowMs) return;
                recentReads.set(key, now());
                if (recentReads.size > 2000) recentReads.delete(recentReads.keys().next().value);
            }
            const write = record(actor, activity, res.statusCode, entityId, source, aborted)
                .catch(() => console.error('Could not save user activity. No request contents were logged.'))
                .finally(() => pending.delete(write));
            pending.add(write);
        };
        res.once('finish', () => finish(false));
        res.once('close', () => { if (!res.writableFinished) finish(true); });
        next();
    }
    function describe(action, type, summary, read = false) {
        return (req,res,next) => { res.locals.auditDescriptor = { action, type, summary, read }; next(); };
    }
    function register(app, { requireRoles, requireManager, rateLimit }) {
        app.post('/api/activity', requireRoles(...ROLES), rateLimit({ windowMs: 60_000, max: 120, message: 'Too many activity events.' }), (req,res) => {
            const { action, page, section } = req.body || {};
            if (typeof action !== 'string' || !Object.hasOwn(UI_ACTIONS, action) || page !== req.auth.role || (section && !SECTIONS.has(section))) return res.status(400).json({ error: 'Invalid activity event.' });
            if (action === 'report.export_requested' && !['manager', 'supervisor'].includes(req.auth.role)) return res.status(403).json({ error: 'This role cannot export reports.' });
            res.locals.auditDescriptor = { action, type: 'interface', summary: `${UI_ACTIONS[action]}${section ? `: ${section}` : ''} (browser-reported).` };
            res.locals.auditEntityId = page;
            res.locals.auditSource = 'interface';
            res.status(204).end();
        });
        app.get('/api/manager/audit-logs', requireManager, async (req,res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                await ready();
                const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit) || 50)));
                const page = Math.min(1000000, Math.max(1, Math.trunc(Number(req.query.page) || 1)));
                const conditions = [], values = [];
                if (ROLES.concat('company_owner').includes(req.query.role)) { conditions.push('COALESCE(log.actor_role, account.role) = ?'); values.push(req.query.role); }
                if (['success','failed','denied','aborted'].includes(req.query.outcome)) { conditions.push('log.outcome = ?'); values.push(req.query.outcome); }
                if (['server','interface'].includes(req.query.source)) { conditions.push('log.source = ?'); values.push(req.query.source); }
                const search = String(req.query.search || '').trim().slice(0, 120);
                if (search) {
                    conditions.push('(COALESCE(log.actor_name, account.name) LIKE ? OR COALESCE(log.actor_email, account.email) LIKE ? OR log.action LIKE ? OR log.summary LIKE ? OR log.entity_id LIKE ?)');
                    values.push(...Array(5).fill('%'+search+'%'));
                }
                const from = ' FROM manager_audit_logs log LEFT JOIN users account ON account.id=log.actor_user_id' + (conditions.length ? ' WHERE '+conditions.join(' AND ') : '');
                const [counts] = await dbp.query('SELECT COUNT(*) AS total'+from, values);
                const [rows] = await dbp.query(`SELECT log.id,log.actor_user_id,COALESCE(log.actor_name,account.name) AS actor_name,
                    COALESCE(log.actor_email,account.email) AS actor_email,COALESCE(log.actor_role,account.role) AS actor_role,
                    log.action,log.entity_type,log.entity_id,log.summary,log.outcome,log.http_status,log.source,log.created_at`+from+' ORDER BY log.created_at DESC,log.id DESC LIMIT ? OFFSET ?', [...values,limit,(page-1)*limit]);
                res.setHeader('X-Total-Count',String(counts[0].total));
                res.setHeader('X-Page',String(page));
                res.json(rows);
            } catch { res.status(500).json({ error: 'Unable to load user activity.' }); }
        });
    }
    return { ready, middleware, describe, register, flush: () => Promise.all([...pending]) };
}
module.exports = { createAuditTrail, routeActivity };

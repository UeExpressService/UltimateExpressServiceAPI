const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const { createGmailConnection, mailErrorSummary } = require('./gmail-connection');

async function fixture(t, changes = {}) {
    const states = new Map();
    let grant;
    const mock = { owner: 'company@example.invalid', verified: true, nonceCorrect: true, scope: 'openid email https://www.googleapis.com/auth/gmail.send', refresh: 'new-private-refresh-token', failExchange: false, writes: 0 };
    const dbp = {
        async query(sql) {
            if (sql.startsWith('SELECT')) return [grant ? [grant] : []];
            return [[], []];
        },
        async execute(sql, values) {
            if (sql.startsWith('INSERT INTO gmail_authorization_states')) {
                states.set(values[0], { browser: values[1], expires: Date.now()+600000, used: false });
            } else if (sql.startsWith('UPDATE gmail_authorization_states')) {
                const state = states.get(values[0]);
                if (!state || state.browser !== values[1] || state.used || state.expires <= Date.now()) return [{ affectedRows: 0 }];
                state.used = true;
            } else if (sql.startsWith('INSERT INTO gmail_authorization ')) {
                grant = { encrypted_refresh_token: values[0], sender_email: values[1] }; mock.writes++;
            } else throw new Error('Unexpected database operation');
            return [{ affectedRows: 1 }];
        }
    };
    const env = { PUBLIC_BASE_URL: 'https://example.invalid', GMAIL_USER: 'company@example.invalid', GMAIL_CLIENT_ID: 'existing-client', GMAIL_CLIENT_SECRET: 'private-client-secret', GMAIL_REFRESH_TOKEN: 'original-env-token', GMAIL_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), ...changes };
    class OAuth {
        constructor(id, secret, callback) { assert.equal(id, env.GMAIL_CLIENT_ID); this.callback=callback; }
        generateAuthUrl(options) {
            mock.nonce = options.nonce;
            assert.equal(options.access_type, 'offline'); assert.equal(options.prompt, 'consent');
            return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ state: options.state, redirect_uri: this.callback, scope: options.scope.join(' ') });
        }
        async getToken() {
            if (mock.failExchange) throw { response: { status: 400, data: { error: 'invalid_grant', secret: 'never-log-this' } }, config: { client_secret: 'never-log-this' } };
            return { tokens: { id_token: 'google-id-token', refresh_token: mock.refresh, scope: mock.scope } };
        }
        async verifyIdToken({ audience }) { assert.equal(audience, env.GMAIL_CLIENT_ID); return { getPayload: () => ({ email: mock.owner, email_verified: mock.verified, nonce: mock.nonceCorrect ? mock.nonce : 'incorrect-nonce' }) }; }
        setCredentials(credentials) { assert.ok(credentials.refresh_token); }
        async getAccessToken() { return { token: 'private-access-token' }; }
    }
    const google = { auth: { OAuth2: OAuth } };
    const connection = createGmailConnection({ dbp, google, env });
    const app = express(); app.use(express.json());
    connection.register(app, () => (req,res,next)=>next());
    const server = app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base = 'http://127.0.0.1:'+server.address().port;
    async function start(origin = env.PUBLIC_BASE_URL) {
        const response = await fetch(base+'/api/admin/gmail/reconnect',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
        const body = await response.json();
        return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0], state: body.authorizationUrl ? new URL(body.authorizationUrl).searchParams.get('state') : undefined };
    }
    async function callback(flow, cookie=flow.cookie) {
        return fetch(base+'/api/admin/gmail/callback?'+new URLSearchParams({state:flow.state,code:'single-use-google-code'}),{headers:cookie?{Cookie:cookie}:{},redirect:'manual'});
    }
    return { start, callback, mock, states, env, dbp, google, connection, getGrant:()=>grant };
}

test('requires the canonical same-origin page and a configured encryption key',async t=>{
    const f=await fixture(t); const denied=await f.start('https://attacker.invalid');
    assert.equal(denied.response.status,403); assert.equal(f.states.size,0);
    const disabled=await fixture(t,{GMAIL_TOKEN_ENCRYPTION_KEY:''});
    assert.equal((await disabled.start()).response.status,503);
    assert.equal(await disabled.connection.getRefreshToken(),'original-env-token');
});
test('starts an offline grant with a secure browser cookie and fixed callback',async t=>{
    const f=await fixture(t); const flow=await f.start();
    assert.equal(flow.response.status,200);
    assert.match(flow.response.headers.get('set-cookie'),/HttpOnly/);assert.match(flow.response.headers.get('set-cookie'),/Secure/);assert.match(flow.response.headers.get('set-cookie'),/SameSite=Lax/);
    assert.equal(new URL(flow.body.authorizationUrl).searchParams.get('redirect_uri'),'https://example.invalid/api/admin/gmail/callback');
    assert.equal(flow.response.headers.get('cache-control'),'no-store');
});
test('rejects missing or substituted browser cookies without saving a token',async t=>{
    const f=await fixture(t);const flow=await f.start();
    assert.match((await f.callback(flow,'')).headers.get('location'),/result=expired$/);
    assert.match((await f.callback(flow,'__Host-ue_gmail_recovery='+'a'.repeat(64))).headers.get('location'),/result=expired$/);
    assert.equal(f.mock.writes,0);
});
test('only the verified company owner with the matching Google nonce can reconnect',async t=>{
    for(const changes of [{owner:'customer@example.invalid'},{verified:false},{nonceCorrect:false}]){
        const f=await fixture(t);Object.assign(f.mock,changes);const flow=await f.start();
        assert.match((await f.callback(flow)).headers.get('location'),/result=wrong-account$/);assert.equal(f.mock.writes,0);
    }
});
test('requires offline Gmail-send permission',async t=>{
    for(const changes of [{scope:'openid email'},{refresh:''}]){
        const f=await fixture(t);Object.assign(f.mock,changes);const flow=await f.start();
        assert.match((await f.callback(flow)).headers.get('location'),/result=permission$/);assert.equal(f.mock.writes,0);
    }
});
test('saves only encrypted credentials, survives restart, and rejects replay',async t=>{
    const f=await fixture(t); assert.equal(await f.connection.getRefreshToken(),'original-env-token');
    const flow=await f.start();assert.match((await f.callback(flow)).headers.get('location'),/result=connected$/);
    assert.equal(f.mock.writes,1);assert.ok(!JSON.stringify(f.getGrant()).includes(f.mock.refresh));
    const restarted=createGmailConnection({dbp:f.dbp,google:f.google,env:f.env});
    assert.equal(await restarted.getRefreshToken(),f.mock.refresh);
    assert.match((await f.callback(flow)).headers.get('location'),/result=expired$/);assert.equal(f.mock.writes,1);
    f.getGrant().encrypted_refresh_token+='tampered';
    await assert.rejects(()=>restarted.getRefreshToken());
});
test('expired state cannot authorize a new grant',async t=>{
    const f=await fixture(t);const flow=await f.start();for(const state of f.states.values())state.expires=0;
    assert.match((await f.callback(flow)).headers.get('location'),/result=expired$/);assert.equal(f.mock.writes,0);
});
test('provider errors are redacted and cannot replace the working credential',async t=>{
    const f=await fixture(t);const first=await f.start();await f.callback(first);const original=f.getGrant().encrypted_refresh_token;
    const output=[];const saved=console.error;console.error=(...args)=>output.push(args);
    try{f.mock.failExchange=true;const flow=await f.start();assert.match((await f.callback(flow)).headers.get('location'),/result=unavailable$/);}finally{console.error=saved;}
    assert.equal(f.getGrant().encrypted_refresh_token,original);assert.ok(!JSON.stringify(output).includes('never-log-this'));
    assert.deepEqual(mailErrorSummary({code:'arbitrary-secret',response:{status:400,data:{error:'invalid_grant'}}}),{code:'invalid_grant',status:400});
});

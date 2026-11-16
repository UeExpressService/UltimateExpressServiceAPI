# Reconnecting the company Gmail sender

The login page and manager sidebar link to `/email-recovery.html`. It works even when website login codes cannot be delivered. Only the configured company Google account can save a new Gmail authorization; website customers never need to grant Gmail access.

## Company owner's steps

1. Open `https://www.ultimateexpress.online/email-recovery.html`.
2. Click **Reconnect company Gmail**.
3. Choose `ultimateexpresswebservice@gmail.com` and review Google's permissions yourself.
4. After approval, the page confirms the mailbox is reconnected.
5. Return to website login and request a new email code.

No token copying, localhost helper, Railway variable editing or deployment is needed for subsequent successful reconnects. Google can still require fresh consent, and a warning may remain until sensitive-scope verification is complete. This does not bypass Google's authorization or guarantee that tokens will never be revoked.

## Deployment setup

- Keep the existing `GMAIL_USER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REFRESH_TOKEN` in Railway's application service.
- Set `PUBLIC_BASE_URL` to the canonical HTTPS site URL.
- Set `GMAIL_TOKEN_ENCRYPTION_KEY` to a privately generated, base64-encoded 32-byte random key. Never put it in source control or client-side JavaScript.
- Register `https://www.ultimateexpress.online/api/admin/gmail/callback` as an authorized redirect URI on the existing Google Web OAuth client.
- The database user needs permission to create the two tables in `migrations/20261116_gmail_recovery.sql`, or an administrator must run that migration first. The application creates them lazily if missing.

## Backend flow and access checks

The reconnect POST accepts only the configured site's Origin and is rate limited. The server creates a ten-minute, one-use OAuth state and binds it to a random Secure, HttpOnly, SameSite=Lax host cookie. The database stores only hashes of the state and browser binding.

The callback atomically consumes a matching unexpired state. Google validates the authorization code. Google's library verifies the returned ID token's signature, issuer and audience; the application additionally checks a verified email matching `GMAIL_USER` and the original nonce. It requires the Gmail-send scope and an offline refresh token before saving anything. A wrong account or failed exchange leaves the working credential unchanged.

The scopes `openid` and `email` identify the consenting mailbox owner; Gmail-send is used for delivery. This does not grant access to customers' Google accounts or Gmail inboxes.

New refresh tokens are encrypted using AES-256-GCM with a random IV and sender/client binding before storage in `gmail_authorization`. Sending reads the saved token, or falls back to the Railway environment token if no database authorization exists. Google's library refreshes short-lived access tokens automatically.

Keep the encryption key stable across deployments and replicas. Back up the key separately from the database. If the key is lost or changed, the saved token cannot be decrypted; restore the correct key or reconnect the company mailbox to replace the encrypted record. All replicas must use the same key and MySQL database.

Email errors log only an allowlisted provider error category and HTTP status. They do not log Google request bodies, tokens or client secrets.

## Validation

Run `node --test server/test-gmail-connection.js` from the repository root. Tests use a fake Google provider and in-memory database adapter; they send no emails and never connect to Railway. They cover browser binding, Origin checks, company identity, permission, nonce, expiry, replay, encryption, persistence, tampering and redacted failures.

After deployment, the company owner must also test the real Google consent flow and normal website login. A success message in a URL alone is not proof of saved authorization; verify the database update and actual delivery.

# User activity log

The Manager's Activity Log includes customer, dispatcher, supervisor and manager activity. Viewing the complete log remains manager-only; recording everyone's actions does not give customers access to other users' records.

## Recorded activity

- Password-verified login-code requests, successful code sign-in, explicit sign-out, first-password changes and completed password resets.
- Account, inquiry, partner, truck, driver and service-request operations, including booking quotations/assignments/status changes and payment recording.
- Waybill listing, uploads and file viewing/downloads.
- Protected data reads and management report views.
- Denied, failed and interrupted requests attributable to a validated session.
- Company Gmail reconnection after Google verifies the company mailbox owner.
- Dashboard loads, supported section/filter changes, list search, export/print requests and route links reported by the shared browser script.

Server actions and browser-reported interactions are labeled separately. An export/print request is not proof that a file was saved or a printer completed its job. Browser interaction events are not a substitute for the protected server action log and can be omitted when JavaScript or network delivery fails.

Identical successful list/report reads from the same user and record/year are grouped into five-minute windows to avoid repeated automatic polling entries. Writes, failed/denied actions, individual waybill file access and explicit interface events are not grouped. Health checks, static files, anonymous visitors, and successful log-list refreshes do not create activity entries. Failed password attempts do not falsely attribute activity to the email address entered by an unverified caller.

This records application activity going forward. Direct manual SQL changes outside the application are not visible to Express middleware, and past unrecorded activity cannot be reconstructed. Existing entries remain available.

## Data and identity

The legacy `manager_audit_logs` table name is retained to preserve history and compatibility. New fields snapshot the actor name, email and role, plus outcome, HTTP status and source. The actor ID comes from the validated session or a server-verified login/reset identity; caller-supplied actor IDs, names, roles and summaries are ignored.

New snapshots preserve identity after account deletion or renaming. Legacy entries are filled only from account information still available during upgrade; unknown historical names are not invented. Passwords, login codes, reset tokens, session tokens, Google grants, request bodies and search text are never copied into audit entries.

`audit-log.js` is installed once before API routes. Existing route annotations supply labels to that central hook instead of writing duplicate events. Audit storage failures are logged without request contents and do not falsely turn a saved business operation into a failed operation. Such failures require administrator investigation; an append-only application table is not a tamper-proof external compliance archive.

## Reviewing history

Manager -> Activity Log provides search, role/result/source filters and Previous/Next pagination. It refreshes the visible first page every 30 seconds. The API retains its array response and supplies `X-Total-Count` and `X-Page` headers.

`GET /api/manager/audit-logs?role=customer&outcome=success&source=server&search=booking&page=1&limit=50`

Search and filter values are bound SQL parameters. Page sizes are limited to 200 rows. No audit delete/edit endpoint is provided.

## Setup and verification

The application creates the table if needed, adds missing columns and snapshots available legacy identities. An administrator can instead apply `migrations/20261116_all_user_audit.sql` once if those columns do not exist. Back up the existing log first. Runtime schema setup tolerates another instance adding the same column concurrently.

Run `node --test server/test-audit-log.js` from the root. Tests use isolated HTTP fixtures and an in-memory database adapter; they never touch Railway, create production users, change passwords, or send email.

# Account roles, partner editing and scheduled payments

## Accounts

Managers can filter all four roles, including Manager. The Create Account role list also includes Manager. In Accounts → Edit, choose Customer, Dispatcher, Supervisor or Manager and save. Role changes ask for confirmation, keep the password and linked booking records, and do not send email. Creating a new account keeps the existing welcome-email flow.

`PUT /api/users/:id` accepts the existing profile fields plus optional `role`. Omitted role keeps the current role for older clients. Only Managers can edit accounts. A Manager cannot change their own role or delete themselves. Account edits and deletion lock the Manager rows and recheck the acting Manager inside the transaction so simultaneous changes cannot remove every Manager.

Each role change increments `users.session_version`. Session tokens carry their version. Every protected request checks the current role and version in MySQL; changing a role back does not revive an earlier token. Tokens issued before this feature count as version zero, matching existing accounts until a role changes. Affected website sessions return to login on `ACCOUNT_ACCESS_CHANGED`. No password or email-code bypass is added.

## Partners

Managers choose Partners → Edit to change the company, contact person, email, phone, partnership type, contract duration and agreement notes. `PUT /api/partners/:id` validates the company and email, preserves omitted optional fields and returns saved database values. The existing partner ID, creation timestamp and associated history stay the same. No email is sent.

## Scheduled payments

Dispatch opens an inquiry, saves its confirmed status and quotation, then enters the due date and optional notes in **Payment schedule**. Its Save button saves the schedule separately from the booking form. Dispatch can update or remove unpaid schedules. A paid or cancelled booking is locked.

Both Dispatch and Manager have **View scheduled payments**. Manager finds it under Transactions; Dispatch finds it in the dashboard header. The list filters All, Upcoming, Due today, Overdue, Paid or Cancelled and searches booking/customer/route. Due dates use Philippine time. There are no automatic email reminders. Customer and Supervisor cannot access this staff payment list.

Scheduling is separate from receiving payment. The quoted amount comes from the saved booking, not a duplicate amount in the schedule. Scheduling does not set `paid_amount` or add revenue. Managers continue recording received payments through Transactions. Paid status in the list comes from the booking's recorded payment.

API:

- `GET /api/payment-schedules`: Manager/Dispatcher list.
- `GET /api/service-requests/:id/payment-schedule`: Manager/Dispatcher booking view.
- `PUT /api/service-requests/:id/payment-schedule`: Dispatcher sets `{due_date: 'YYYY-MM-DD', notes: ''}`; `due_date: null` removes an unpaid schedule.

The additive `service_request_payment_schedules` table uses the booking ID as its primary key. `session-version-store.js` prepares the users column and `payment-schedules.js` prepares its table on first use. Existing installations do not need manual migrations. `migrations/20261117_manager_features.sql` is an alternative for administrators; do not add the users column twice. The fresh schema includes both additions.

Role edits, partner edits and schedule changes are recorded in the activity log using the authenticated actor. All styling remains in `Latest Update/styles/style.css`, including section 17 for scheduled payments.

Validation: `node server/test-password-resets.js` runs the real HTTP/MySQL suite in an isolated temporary database. It includes Manager feature tests for permissions, session revocation, simultaneous edits, preserved passwords/agreements, due date validation, payment states and scheduling without revenue. Its email provider is captured in memory. No production account, order, payment or attendance test data is created.

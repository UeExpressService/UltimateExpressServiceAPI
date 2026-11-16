# Fleet availability, daily attendance and booking reviews

## Customer

The Customer portal shows five fleet categories using the Landing Page's published starting amounts: Light Duty Van ₱5,000; Medium Box Truck ₱12,000; Heavy Cargo Truck ₱20,000; Refrigerated Truck ₱18,000; Wing Van / Trailer ₱30,000. These are initial quotation references, not daily rates or recorded revenue. Change both the public Landing Page and `operations.js` catalog if the published prices change.

`GET /api/customer/fleet` returns category totals and currently available counts from truck status. Plates starting `DEMO-` or `TEST-` are excluded. It exposes no individual fleet records or driver information. Current status does not guarantee a future booking date or reserve a truck. Unknown truck types require Dispatch advice. A fleet card opens the existing quote form and selects its preferred truck category; the normal quotation workflow still applies.

## Daily driver shifts

Supervisor and Manager can read `GET /api/driver-shifts?date=YYYY-MM-DD` and record `POST /api/drivers/:id/time-in` or `time-out`. The Supervisor dashboard provides the controls. Dates and display times use Philippine time. Server timestamps are used; historical dates are read-only. One shift per driver per day is allowed. An open shift from yesterday must be closed before today's shift starts. Locking the driver row prevents simultaneous duplicate clock-ins. Attendance does not change trip availability.

## Confirmed bookings sent to the Supervisor

1. Dispatch saves an approved/ongoing booking with an assigned truck and driver.
2. Open its inquiry and choose **Send to Supervisor**. This adds it to the Supervisor's review queue.
3. Supervisor checks the route, cargo, pickup, assignment and quotation, optionally adds notes, then chooses **Mark reviewed**.

This is an in-app handoff; it sends no email. Review never blocks dispatch or marks a booking approved. Repeated sending of unchanged details keeps the existing review. Relevant booking changes invalidate its version: Dispatch must save and resend, and Supervisor must refresh before reviewing. Normal status progression alone keeps the review valid.

Routes: `GET/POST /api/service-requests/:id/supervisor-review` for status/send; `GET /api/supervisor/confirmed-bookings` for the queue; `PUT /api/service-requests/:id/supervisor-review` with `{version,notes}` to review. Only Dispatch sends; Supervisor/Manager review; Customers cannot access the queue. The existing activity log records these actions with the authenticated actor.

## Storage and validation

`driver_shifts` stores daily attendance with a unique driver/day key. `supervisor_booking_reviews` stores sender, timestamps, review notes and hashes of booking details. Both tables are additive and created on first use, or with `migrations/20261116_fleet_operations.sql`. No existing account, order or fleet row is migrated. Application validation is used instead of foreign keys because older installations have differing ID types. Deleting a driver leaves historical shifts stored; the current attendance list shows existing drivers.

All UI styling remains in `Latest Update/styles/style.css`, section 16. Role hooks use shared `Latest Update/operations.js`. Saving a Supervisor truck now preserves its rate; the backend also preserves omitted rates and rejects invalid amounts.

Run `node server/test-password-resets.js` for isolated MySQL/HTTP integration coverage, including `test-operations.js`. It creates its own local database, captures email in memory, tests all roles, concurrency/overnight attendance, version checks, dispatch continuity and audit events. It never creates test orders or attendance in Railway.

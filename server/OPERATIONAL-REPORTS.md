# Printable operational reports

Manager: Records > Generate Monthly Report. Supervisor: Generate Activity Report.
Choose a reporting month or a custom range, generate the PDF, then download it
and print it from the PDF viewer. CSV exports remain available as record exports.

The server generates standalone A4 PDFs with company branding, dates, preparer,
report ID, repeated table headers and page numbers. The Management Report uses
portrait pages, summary cards, weekly totals, transaction details, payment and
quotation totals, and signature lines. Other reports use landscape pages.
No email is sent.

## Reports and access

- Management Report: Manager only. Booking transaction details,
  recorded payment details, quote totals, unpaid quotes and payment averages.
- Booking and Delivery Report: Manager and Supervisor. Booking status totals,
  monthly breakdown and detailed routes and assignments.
- Fleet and Driver Activity Report: Manager and Supervisor. Confirmed trip counts,
  drivers in trips, new drivers, new trucks, and trucks assigned to customer trips.
  Each of those four lists is also available as a separate PDF in the report selector.

`GET /api/reports/{type}.pdf?from=YYYY-MM-DD&to=YYYY-MM-DD`
accepts `payments`, `bookings`, `fleet`, `drivers`, `newdrivers`, `newtrucks`,
or `customertrucks`. It
uses the existing Bearer session and current database role. Downloads are not
cached. Periods are inclusive, between 2000 and 2099, and limited to 366 days
and 5,000 bookings/payments. The database is read in one consistent snapshot.
Report generation is recorded in the activity log.

## Date and calculation rules

Bookings use their scheduled pickup date, falling back to creation date only
when pickup date is absent. Payments use the Manager-recorded payment date,
so a selected month's payments can include a booking from another month.
The PDF separates booking details from payments recorded during the period.
Financial sums use integer cents. Downloads show records and totals without
formula/basis columns, technical notes or completion/assignment percentages.

New/pending/blank statuses are Pending; approved/ongoing are Ongoing. Completed
and Cancelled remain separate; unrecognized statuses appear as Other.
Confirmed trips include approved, ongoing and completed bookings only.
Trip lists exclude pending and cancelled bookings. Customer trip truck rows
show the saved truck, driver, customer, route, booking date and status; they
are assignment records rather than independently verified vehicle visits.
New drivers/trucks use their record creation date in the selected period,
including the first and last days. They do not depend on having a booking.

Statuses and assignments are their current saved values at generation time.
The system does not store actual arrival times or complete reassignment
history, so these reports do not claim on-time performance or utilization
measured in hours. Unpaid quotes are saved confirmed quotes with no payment
amount, not the difference between the period's quotes and payments.

## Verification

Use Node 20.19 or later. `npm run test:operational-reports --prefix server`
checks dates, status/resource calculations and PDF rendering. The isolated
`node server/test-password-resets.js` harness checks real MySQL queries, API
permissions, monthly boundaries and payment-date differences alongside the
existing regression suite. It creates a temporary database and captures mail
in memory; it never connects to Railway or sends mail.

Optional browser QA: set `UE_REPORT_BROWSER_QA` to an installed Playwright
module path and `UE_BROWSER_EXECUTABLE` to a Chromium executable. Set
`UE_REPORT_QA_DIR` to save generated test PDFs and interface screenshots.
These artifacts contain synthetic test data and are not business records.

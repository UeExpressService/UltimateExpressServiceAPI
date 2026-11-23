# Panel system revisions

Implemented locally on 18 November 2026. Thesis-paper edits remain with the analyst. No chatbot or automated conversation was added.

## Guest inquiry workflow

On 19 November 2026 the landing-page inquiry form was replaced with a static FAQ, as requested. Services now link to the FAQ, desktop and mobile navigation include FAQ, and the existing company phone/email remain available for quotation discussions. Customer quote requests still use the signed-in Customer portal. No chatbot was added. The earlier landing form and its submission handler are no longer present, and the FAQ does not claim to submit or store a message.

Existing messages in `customer_account_requests` and their staff follow-up controls are preserved. The earlier submission API remains for compatibility; this landing-page change does not delete messages or alter accounts, bookings or payments.

Dispatcher: Website Inquiries appears above Booking Requests. Manager: choose Website Inquiries in the sidebar. Both roles can view guest contact details and messages, open email/phone links, and save follow-up notes and New, Contacted, Closed/processed or Declined status. Refresh runs every 30 seconds while no inquiry is expanded. Opening an email/phone link does not mark the guest as contacted or send anything automatically. Use Save follow-up after contacting the guest.

The Manager can still create an account from a New or Contacted inquiry under Accounts. Account creation marks the inquiry processed. Dispatcher permissions do not include account creation. Customer and Supervisor accounts cannot read the guest inbox.

## Pricing assistance

Manager: Route Tariffs manages company rates with route/vehicle description, base fare, included distance, additional PHP/km, maximum applicable distance, notes and active status. No company tariff is seeded or inferred from competitor prices.

Dispatcher: open a booking or Manual Quotation, then Route price assistance. Choose the applicable reference, enter or check road distance and additional charges, calculate, and explicitly use the amount. Save the booking to persist it. Existing quoted amounts and recorded payments are not modified by changing a tariff or calculating an estimate. Paid quotes stay locked.

Formula: base fare + max(0, road km - included km) × additional PHP/km + additional charges, rounded to centavos. Company tariffs use the Manager's stated maximum range. Map distances are estimates; straight-line fallback distances are never used for pricing.

### External market references

Checked on 18 November 2026 against [Lalamove's published pricing page](https://www.lalamove.com/en-ph/all-delivery-pricing-detail). Three regular-delivery examples are available: 3,000 kg 6W aluminum van (PHP 1,450 + PHP 33/km), 5,000 kg 6W large aluminum van (PHP 2,694 + PHP 34/km), and 12,000 kg 10W wing van (PHP 7,200 + PHP 85/km). These are external comparisons, not a government tariff or Ultimate Express's approved formula. The source publishes multiple service areas and separate long-distance terms. Verify the matching area/vehicle and the current carrier quote before relying on a comparison.

The application's reference calculator is intentionally limited to 50 km. This is an application guardrail, not a claim that the provider guarantees those prices or that 50 km is a nationwide pricing boundary. Use a company-approved tariff or a manually agreed quote outside this range. Tolls, ferries, helpers, waiting and tax treatment require review; only explicitly entered extra charges are added. References are not refreshed automatically. No fixed diesel pump price is assumed; [DOE fuel monitoring](https://doe.gov.ph/prices/fuels) provides current regional information when the company later adopts a fuel-based formula.

## Maintenance

### Round trip distance and completed delivery mileage

Added on 20 November 2026. A valid road-map route is stored as one-way kilometers, bound to the saved pickup and delivery addresses. The route display and Dispatch pricing helper use the outbound-and-return total (one-way km multiplied by two). The return assumes the same distance; it is an estimate rather than vehicle tracking. Mileage is rounded to the existing odometer precision of 0.1 km. Manual pricing input is labeled as round-trip distance and does not replace the saved mapped trip distance.

Dispatch saves the mapped route with a call-in quotation or booking edit. Changing route addresses invalidates the prior distance unless a fresh matching map distance is supplied. Missing road routing does not convert the straight-line fallback into billable or recorded trip distance. Paid quotes retain their existing amount.

On the first transition to Completed, the booking and assigned truck are locked and the saved round-trip kilometers are added to `truck_maintenance.odometer` in the same transaction. The unique booking entry in `completed_trip_mileage`, maintenance version increment and full history snapshot protect against repeated/concurrent completion and stale maintenance forms. Pending, approved, ongoing and cancelled bookings add no kilometers. Older completed bookings are not backfilled or reopened. Existing service baselines and component fields remain intact.

An assigned truck, a valid saved map distance and a real recorded starting odometer are required before a delivery can complete. Supervisor/Manager records the starting reading in Truck Maintenance. The oil reminder is recalculated from the updated reading and the configured interval; completing a delivery does not reset the last oil service or automatically change truck roadworthiness status.

### Dispatcher maintenance inspection requests

Dispatch uses Maintenance Check Form in the dashboard header to choose a truck, priority and reason. The Supervisor sees the shared Maintenance Check Requests list and records In progress or Checked with findings. Dispatch can follow the result; Manager can view it under Maintenance. Only Dispatch creates requests and only Supervisor saves inspection findings. A truck cannot have two open requests simultaneously, and reviews use a version check. Each saved request can be printed using Print Maintenance Form.

Requests do not send email or change truck availability automatically. Supervisor records actual readings/service work in Truck Maintenance and updates operational fleet status separately when needed. `truck_inspection_requests` retains the request and findings. All protected actions use the authenticated actor and the activity log.

The Manager's Revenue menu and page are now labeled Records. Payment totals, report data and saved transactions retain their calculations; displayed financial labels use recorded payments.

Before these changes, a separately verified source backup was created at `C:/Users/almen/Downloads/Ultimate Express Backups/UltimateExpress-before-trip-maintenance-20261120-131221.zip`. A full logical MySQL backup was also completed before production schema changes at `C:/Users/almen/Downloads/Ultimate Express Backups/UltimateExpress-database-before-trip-maintenance-20261120-132516.sql`. Keep database backups private.

Supervisor and Manager can record actual odometers, last oil service mileage/date, engine/filter details, liters, tire size, dated readings for all eleven positions and inspection notes. A saved snapshot is retained in maintenance history. Changes use version checks so a stale form cannot overwrite another user's update. Odometers cannot decrease.

The provisional administrative oil reminder is 5,000 km or 3 months, whichever comes first, editable per truck. Due-soon means within 500 km or 14 days. These defaults were chosen while the company's detailed schedule is unavailable; they are not a universal manufacturer requirement. Missing service baselines display Baseline required. Enter the actual last service and odometer before using the reminders. No photographic rows were imported as current inspections.

Tire classification follows the supplied company sheet's legend: 10/32 inch excellent, 5/32 good, at most 4/32 replacement review, and at most 2/32 danger. Readings between 4 and 5/32 show monitor. Select 1/32 inch or millimeters explicitly; 1 inch equals 25.4 mm. Changing the unit clears entered readings so old values cannot silently change meaning. Missing positions are not assumed measured. Reminders do not certify roadworthiness or silently change truck availability; a Supervisor still determines the operational status.

## Battery and fuel-filter monitoring

Added on 18 November 2026 as monitoring features only. No rows were imported from the supplied photographs.

Supervisor and Manager can enter battery serial number(s)/model, installation date, due date and battery notes; and fuel-filter model/part number, installation date, due date and notes. The vehicle model/year is optional and the existing engine number is shared with the oil-service record. Battery and Fuel Filter reports are available beside the oil and tire reports, in both staff dashboards.

Due dates are entered by staff from the actual service/check schedule. No automatic battery lifespan or fuel-filter interval is assumed. Reminders distinguish unrecorded details, a missing due date, scheduled checks, checks due within 14 days, checks due today and overdue checks. Installation dates cannot be in the future, dates must be valid and a due date cannot precede a known installation date.

Component-only entries can be saved when the odometer is unknown, without inventing mileage or oil-service baselines. A known saved odometer cannot be cleared or decreased. The additional fields are included in each saved history snapshot. Older clients that omit the new fields preserve previously saved component details. Existing oil/tire rows survive the additive column migration.

Verification covers the older schema with an existing oil record, component date boundaries, invalid dates, omitted-field preservation, component-only entries, Manager/Supervisor access, shared dashboard persistence, phone layout and PDF rendering of both reports. Photo records remain outside the system as requested.

## Printing

The shared print preview supports branded Manager and Dispatcher receipts, Management reports, filtered Fleet reports, oil/filter reports and tire monitoring reports. The browser Print / Save as PDF action prints only the preview. Existing CSV exports remain available. Oil/tire sheets use landscape orientation; long tables repeat headers and avoid splitting individual rows. Receipts distinguish quotes from recorded payments. A static FAQ explains the guest inquiry process on the landing page.

## Storage and deployment

The new feature endpoints prepare their additional tables/columns on first authorized use and retry setup after a failed migration. Fresh installations include the structures in `railway-schema.sql`. Older installations do not need their existing tables recreated. Database credentials need permission for the additive CREATE/ALTER operations. Existing accounts, bookings and payments are retained.

Deployed directly to the existing Railway production service on 18 November 2026. The initial panel release was deployment 49d69a42-7ac1-4e62-ad21-c866eba6b742. Battery and fuel-filter monitoring was subsequently deployed successfully as 3a248a5f-7234-4a87-878b-8882edeced81. The live maintenance script and stylesheet match the tested workspace. The live pages and new scripts match the tested workspace, /health returns success, and staff-only APIs require sign-in. The additive inquiry, tariff and maintenance storage was prepared and checked against the live database without inserting or changing business records. Existing guest inquiries and trucks remain available. Production email was not used for tests. GitHub main is still at commit 583134bf67fd216b1ce7da7ec9a67edc1d43e1d6 and has not been updated with this release; synchronize the source changes before a future GitHub-based deployment. The source folder has no Git metadata; a source backup was saved outside the repository before edits.

## Verification

`node --test server/test-revision-rules.js server/test-audit-log.js server/test-gmail-connection.js` checks pricing bounds, included kilometers, centavo rounding, oil date boundaries, tire units, authorization/audit behavior and Gmail recovery.

`node server/test-password-resets.js` starts its own temporary local MySQL instance, captures email in memory, verifies password/code sign-in for all roles and exercises `test-panel-revisions.js` against real HTTP endpoints and MySQL. The revision checks cover the retained inquiry API, shared staff visibility, follow-up persistence, access denial, account creation after contact, external/company estimates, maintenance history, stale edits and new static scripts.

That harness also runs `test-trip-maintenance.js`. It checks old-schema preparation, role permissions, duplicate inspection requests, required findings, stale reviews, missing odometer rollback, invalidated map distances, concurrent completion, exact single mileage application, next-service alerts, preserved service baselines, history, cancellation and no historical backfill. Optional browser QA additionally exercises mapped round-trip pricing, delivery completion, the Dispatcher request form, Supervisor findings, printable request, Records labels and phone layout.

Optional browser QA also runs when `UE_PLAYWRIGHT_MODULE`, `UE_BROWSER_EXECUTABLE` and `UE_UI_OUTPUT` point to a local Playwright package, a test browser executable and a writable output directory. It uses temporary test sessions only. It checks the public FAQ and removal of the inquiry form, keyboard interaction and mobile layout, preserved inquiry follow-up, safe rendering, tariff entry and quotation, maintenance entry, unit switching and rendered print PDFs. The browser test replaces the localhost API configuration with the harness's random local port and blocks third-party network requests.

Before the FAQ replacement, a fresh source backup was created and every archived file was checked against its SHA256 fingerprint: `C:/Users/almen/Downloads/Ultimate Express Backups/UltimateExpress-before-FAQ-revisions-20261119-232229.zip`. It contains 96 files and excludes only the reinstallable `node_modules` dependency cache. Pricing assistance, kilometer/date maintenance reminders and printable reports were already implemented and were retained.

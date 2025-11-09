# Management Dashboard Requirements

## Goal
Provide compliance, operations, and store leadership with a single place to monitor verifications, overrides, banned IDs, and kiosk health without slowing down front-line clerks.

## Deployment Options
1. **Lightspeed Embedded Page**
   - Launch via Retail X-Series custom button.
   - Pros: reuse Lightspeed auth/session, familiar POS context.
   - Cons: iframe restrictions, limited screen real estate, harder to cache heavy charts.
2. **Standalone Web App**
   - Hosted next to the backend (e.g., `/admin`).
   - Pros: full control over UI/UX, easier to add monitoring widgets.
   - Cons: must own authentication layer (API keys, SSO) and manage access roles.

Decision factors: POS team appetite for custom button work, need for mobile access, security/compliance requirements.

## Core Views
1. **Live Compliance Summary**
   - Data from `/api/reports/compliance?days=1` and `?days=30`.
   - Metrics: total verifications, approval rate, top rejection reasons, bans flagged.
   - Alerts surfaced inline (e.g., >5 failures in 10 minutes).
2. **Override Log**
   - Table powered by `/api/reports/overrides?days=30`.
   - Columns: timestamp, clerk, manager, document type, note, sale link.
   - Filters: location, manager, reason keyword.
3. **Banned Customer Registry**
   - CRUD operations via `/api/banned` (GET/POST/DELETE already available).
   - Import/export CSV for quarterly audits.
4. **Kiosk Health**
   - Aggregated results from smoke tests / retention runs.
   - Display last successful run, duration, and highlight failures.

## Supporting Lightspeed APIs (Retail X-Series)
- `GET /sales/{id}` for contextual sale details (line items, totals).
- `POST /sales/{id}/notes` for adding audit notes when overrides occur.
- `GET /customers/{id}` (if we link verifications to customer profiles).
- `GET /outlets` to map location IDs to friendly store names.

Authentication strategy (when not embedded): reuse our existing API key model initially, then explore OAuth against Lightspeed for SSO once production-ready.

## Performance Expectations
- Data refresh every 30–60 seconds via polling or websockets.
- All UI actions must respond < 500 ms to avoid slowing decision-making.
- Heavy queries (e.g., CSV exports) run async with progress feedback.

## Next Steps
1. Stakeholder decision: embedded vs. standalone.
2. Wireframe key views and review with compliance/ops.
3. Build MVP on staging using existing APIs; expand with Lightspeed data once access approved.

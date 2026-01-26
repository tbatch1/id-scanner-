# Project Brain (End-to-End Overview)

This is the “everything in one place” snapshot of how the THC Club ID Scanner project works: what runs where, which pages are used in production, how Lightspeed talks to us, how scanning is captured, what the API does, what’s in the database, and what to check when something breaks.

---

## What This Project Does

- Provides an **age verification step** for THC Club checkout flows.
- Accepts scans from:
  - **Bluetooth HID scanners** (keyboard-emulation) in an iPad + Lightspeed iframe flow.
  - **Camera-based scanning** (Dynamsoft) for browser/kiosk use cases.
- Persists an **audit trail** for compliance (verifications, overrides, completions, banned IDs).
- Integrates with **Lightspeed Retail (X‑Series)** for sale context and (optionally) writes.

---

## Top-Level Architecture

**Frontend (static HTML/JS in `frontend/`)**
- Production scanning page used in the iPad + Lightspeed iframe: `frontend/payment-gateway-stable.html`
- Additional flows/tools:
  - `frontend/checkout.html` (guarded checkout demo flow)
  - `frontend/scanner.html` (camera scanning w/ Dynamsoft)
  - `frontend/scanner-test.html` (scan diagnostics page)
  - `frontend/id-scan.html` (verify page route)
  - Admin UIs: `frontend/admin-*.html` + `frontend/admin-shared.css`

**Backend (Node/Express in `backend/src/`)**
- Main Express app: `backend/src/app.js`
- Main API router: `backend/src/routes.js`
- Local dev server entry: `backend/src/server.js`
- DB + compliance persistence: `backend/src/db.js`, `backend/src/complianceStore.js`, schema: `backend/src/schema.sql`
- Lightspeed integration (mock + real): `backend/src/lightspeedClient.js` and related modules

**Vercel deployment**
- Serverless function wrapper: `api/index.js` (loads `backend/src/app.js`)
- Routing + headers: `vercel.json`

---

## Production URLs (Vercel Rewrites)

Defined in `vercel.json`:

- API base:
  - `/api/*` → `api/index.js` → Express app
- Scanner / checkout pages:
  - `/payment-gateway-stable.html` → `frontend/payment-gateway-stable.html`
  - `/payment-gateway.html` → `frontend/payment-gateway-auto.html`
  - `/id-scan.html` → `frontend/id-scan.html`
  - `/scanner.html` → `frontend/scanner.html`
  - `/scanner-test.html` → `frontend/scanner-test.html`
- Admin pages:
  - `/` redirects to `/admin/data-center.html`
  - `/admin/*.html` rewrites to `frontend/admin-*.html`
  - `/admin/*` API routes rewrite to `/api` (admin API is served by the main Express router)

---

## Primary Production Flow (iPad + Lightspeed iframe)

The page is: `frontend/payment-gateway-stable.html`

High-level behavior:

1. Lightspeed opens our page in an **iframe modal** from a custom button.
2. iPad WKWebView constraint: **Bluetooth HID keystrokes often do not route into the iframe until the user taps inside the iframe**.
   - This is why the UI is built around **tap-to-arm** scanning.
   - Reference: `docs/SCAN_CAPTURE_STABILITY.md`
3. After arming, the scanner’s HID payload is captured, parsed enough to determine DOB/ID fields, then verified via API.
4. Page shows the result (age/approved/rejected) and then returns control to POS.

Caching note:
- Vercel sets `Cache-Control: no-store` for `/payment-gateway-stable.html`, but iPads/POS wrappers still cache sometimes.
- Use a cache-buster query param in the Lightspeed button URL (example): `...?v=rollback1`

---

## Scanning Realities (Bluetooth HID)

What a driver’s license PDF417 scan looks like:
- It’s one scan payload, but it often contains **line breaks** and field tags like:
  - `@ANSI...`
  - `DBB` (DOB), `DAQ` (document ID), plus many other fields.
- Notes/Notepad showing multiple lines is normal.

What the frontend must do to be reliable:
- Buffer fast keystrokes.
- Don’t assume `Enter`/`Tab` means “done” (scanners vary).
- Use a short “quiet-time” window to decide “scan complete”.
- In an iframe, focus can be stolen; stable page uses a focusable input and a tap-to-arm strategy.

---

## Backend API (What Exists / Why)

API is implemented in `backend/src/routes.js` and called by the frontend(s).

Common endpoints you’ll see used:

- Health / diagnostics
  - `GET /api/health` (optionally checks DB depending on query params used by callers)
  - `GET /api/debug/ping` (connectivity test)
  - `POST /api/debug/client-errors` (frontend logs/errors for diagnostics)

- Sale verification & completion (compliance-critical)
  - `POST /api/sales/:saleId/verify`
  - `POST /api/sales/:saleId/complete`
  - Manager override endpoint exists in the codebase (`validateOverride`) and runbook describes the flow.

- Reports (compliance exports)
  - `GET /api/reports/compliance?days=30&limit=50`
  - `GET /api/reports/overrides?days=30&limit=200`

- Banned customers
  - `GET /api/banned`
  - `POST /api/banned`
  - `DELETE /api/banned/:id`

Lightspeed integration endpoints are also present (OAuth/login/refresh/status, webhooks), described in `docs/RUNBOOK.md` and `ENV_VARIABLES_REFERENCE.md`.

---

## Database Model (Compliance Storage)

Schema is defined in `backend/src/schema.sql`.

Core tables:
- `verifications`
  - One row per scan attempt that reaches verification.
  - Stores: `sale_id`, `clerk_id`, age, DOB, doc number/type/country, status/reason, IP/UA, `location_id`, timestamps.
- `sales_completions`
  - Links a completed sale to a verification and payment type.
- `verification_overrides`
  - Manager override audit trail linked to `verifications`.
- `banned_customers`
  - Document-based bans (plus optional identifying info).

Views:
- `compliance_report` (join verifications + completions)
- `daily_stats` (dashboard summaries)

Important operational fact:
- If `DATABASE_URL` is missing/unavailable, parts of the API will fall back to mock/in-memory behavior and compliance endpoints can return `503`.

---

## Lightspeed Integration (Conceptual)

Two modes:
- **Mock mode** (for demos/local): `LIGHTSPEED_USE_MOCK=true`
- **Live mode** (production): OAuth + real Retail API calls

Key ideas:
- The frontend needs the current sale context (sale id, clerk id, outlet/location).
- Backend can optionally write back (notes/payments) when `LIGHTSPEED_ENABLE_WRITE=true`.
- OAuth refresh/token state is monitored via admin endpoints + admin UI.

Runbook: `docs/RUNBOOK.md`

---

## Admin / Manager Dashboard

Admin pages are static HTML in `frontend/` and call admin API endpoints under `/admin/*` that are rewritten to `/api` in `vercel.json`.

Primary entry:
- `/admin/data-center.html` (also `/` redirects here)

Other pages:
- `/admin/scans.html`, `/admin/banned.html`, `/admin/audit.html`, `/admin/marketing.html`, `/admin/oauth.html`

Security model:
- API authentication via `API_SECRET_KEY` (`X-API-Key`)
- Admin authentication via `ADMIN_TOKEN` (`X-Admin-Token`)
- See `ENV_VARIABLES_REFERENCE.md` for setup guidance.

---

## Scheduled Jobs (Vercel Cron)

Configured in `vercel.json`:
- `/api/cron/retention`
- `/api/cron/customer-reconcile`
- `/api/cron/webhooks`
- `/api/cron/customers`

Purpose (high-level):
- Retention enforcement (compliance data housekeeping)
- Webhook processing + customer reconcile queues
- Customer sync tasks

---

## Local Development / Validation

Quickstart patterns (varies by task):
- Start backend locally: `npm run start` (or run the Express server via `backend/src/server.js`)
- Smoke tests: `npm run smoke` (see `docs/SMOKE_TESTS.md`)
- Unit tests: `npm test`

If you need to reset scanning behavior:
- Baseline restore instruction: `docs/SCANNER_BASELINE.md`

---

## Hardware Guidance (Reality-Based)

If you’re building for iPad + HID:
- Best experience is typically **Socket Mobile (S740)**.
- Cheaper HID scanners can work but are more likely to:
  - send odd suffixes (`Tab`/`Enter`)
  - reconnect unpredictably between iPads
  - flood keystrokes too fast or inconsistently

Netum-specific docs (if/when needed):
- `docs/NETUM_NT1200_SETUP_GUIDE.md`
- `docs/NETUM_NT1200_CONFIGURATION.md`

---

## “Where We Are” Right Now (Operational Snapshot)

- Production iPad flow uses: `payment-gateway-stable.html` in a Lightspeed iframe.
- Scanner choice: Socket Mobile S740 is the preferred Bluetooth HID scanner for reliability.
- Current Lightspeed URL pattern includes a cache-buster `v=` query param so iPads don’t load a stale copy.

---

## Key URLs & Launch Patterns

### Lightspeed Custom Button (iPad iframe verifier)
- Use the stable verifier page:
  - `/payment-gateway-stable.html?v=<anything>`
- Why `v=` exists:
  - Even with `Cache-Control: no-store`, iPad/POS wrappers can still serve stale cached HTML. A changing `v=` forces a refresh.

### Demo / Local guarded checkout (non-iPad kiosk flow)
- Preferred (served by backend so it can proxy `/api` cleanly):
  - `/demo/checkout?saleId=SALE-1001&clerkId=bartender-7`
- Direct file load (only for quick UI iteration):
  - `frontend/checkout.html?saleId=...&clerkId=...&type=cash|card&autoClose=true`

---

## Query Params (What We Actually Support)

This is the short list that matters operationally. (There are additional fallbacks in code to handle different Lightspeed trigger formats.)

### `payment-gateway-stable.html`
- `v=`: cache-buster only.
- `mode=`:
  - `mode=tender` enables tender/cash UI; default in iframe is verify-only.
- `autoStart=1`: auto-arms scanning on load (useful for testing on non‑iOS; not reliable in iPad iframes).
- `tapToScan=1`: force manual tap-to-arm behavior.
- `debugUi=1`: diagnostics overlay (does not show the raw scan payload).
- `debugKeys=1`: shows raw scan keystrokes in the UI (**use only when troubleshooting; can expose barcode payload**).
- `maskKeys=1`: shows a masked “receiving input” indicator instead of raw scan text.
- `debug=1`: enables both `debugUi` and `debugKeys`.
- `noKbHack=1`: optional iPad-only focus/keyboard suppression hack (use if the OS keyboard still appears).

### Demo checkout (`demo/checkout` or `frontend/checkout.html`)
- `saleId` (required)
- `clerkId` / `employeeID` (required)
- `type=cash|card` (enables auto-close behavior)
- `locationId` / `outletId` (drives compliance location)
- `autoClose=true|false`
- `api=` (override API base URL)

---

## Environment Variables (What Matters in Prod)

Full reference: `ENV_VARIABLES_REFERENCE.md`

### Required in production
- `DATABASE_URL`: Postgres connection string.
- `API_SECRET_KEY`: required to prevent anyone from faking compliance records (sent as `X-API-Key` by clients).
- `ADMIN_TOKEN`: required to protect admin API calls (sent as `X-Admin-Token` by admin UI).

### Operationally important
- Lightspeed OAuth + writes:
  - `LIGHTSPEED_CLIENT_ID`, `LIGHTSPEED_CLIENT_SECRET`, `LIGHTSPEED_REDIRECT_URI`
  - `LIGHTSPEED_OAUTH_SCOPES`
  - `LIGHTSPEED_ENABLE_WRITE` (keep `false` until confident)
  - Payment mappings: `LIGHTSPEED_PAYMENT_TYPE_ID_CASH`, `LIGHTSPEED_PAYMENT_TYPE_ID_CARD`
- CORS safety:
  - `ALLOWED_ORIGINS`
- Cron safety:
  - `CRON_SECRET` (optional protection for cron endpoints)

---

## Production Readiness / Known Blockers

Reference: `PRODUCTION_READINESS.md`

High-level themes:
- Ensure scanning libraries are properly licensed (camera scanning).
- Ensure DB cold starts + pooling won’t cause “first scan is slow” across many stores.
- Ensure authentication is enabled (API + admin) before wide rollout.
- Ensure retention policy meets compliance requirements and is scheduled via cron.

---

## Operational Playbooks (How We Run This)

### Pilot / staging checklist
- `docs/PILOT_CHECKLIST.md`

### Production rollout + rollback
- `docs/PRODUCTION_ROLLOUT.md`

### Smoke tests (run before deploy)
- `docs/SMOKE_TESTS.md`
- Run: `npm run smoke`

---

## Banned IDs & Overrides (Compliance Operations)

Reference: `docs/BANNED_CUSTOMERS.md`

Key points:
- Banned check happens on every verification attempt.
- Banned hits must block auto-complete even if the age is 21+.
- Overrides require a manager PIN (`OVERRIDE_PIN`) and create an audit record in `verification_overrides`.
- Review overrides weekly; notes must be complete for inspections.

---

## Alternative iPad Strategies (If iframe ever becomes unusable)

Reference: `docs/scanning_gameplan.md`

Options:
1. **Companion App workflow** (separate Safari “web clip” scanner app, then switch back to Lightspeed).
2. **Deep link return** (scan in Safari, then redirect back into the Lightspeed iOS app for the sale).
3. **Pure keyboard emulation into Lightspeed fields** (not recommended for AAMVA payloads; too messy).

---

## Troubleshooting (Fast Triage)

### “Scanner works in Notes but not in Lightspeed iframe”
- Cause: iPad WKWebView requires a tap inside the iframe before HID keystrokes route.
- Fix: tap inside the iframe once (Scan/tap target), then scan again.

### “Everything looks instant in Notes”
- Normal for good scanners (Socket S740). It sends one fast keyboard burst.

### “Scans fail randomly at scale”
- First suspect DB cold starts / pool exhaustion; check `PRODUCTION_READINESS.md` items and `/api/health` latency.

### “Compliance reports are blank / 503”
- DB not configured/reachable (`DATABASE_URL`), or migrations not applied (`backend/src/schema.sql`).

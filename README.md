- Automated coverage: `npm test -- --testPathPattern=routes.reports` exercises both reporting endpoints.
## THC Club Guarded Checkout Prototype

This snapshot wires a mock Lightspeed back office into an age-verification scanner so you can demo the “no scan, no sale” flow before production credentials arrive.

### Folder layout
- `backend/` – Node/Express service that simulates the Lightspeed API (`src/mockLightspeedClient.js`) and exposes checkout endpoints (`/api/sales/:id`, `/verify`, `/complete`).
- `frontend/checkout.html` – Guarded checkout UI built around the ZXing PDF417 reader; talks to the backend via `fetch`.
- `id-scanner.html` – Original standalone scanner left untouched for reference.

### Getting the mock server running
1. From `backend/` copy `.env.example` to `.env` and tweak defaults if needed.
2. Install dependencies once you have network access:
   ```bash
   cd backend
   npm install
   ```
3. Start the service (`npm start`). It defaults to `http://localhost:4000`.
4. Hit `http://localhost:4000/api/health` to confirm the mock is live.
5. Open `http://localhost:4000/demo/checkout?saleId=SALE-1001&clerkId=bartender-7` to load the scanner via the backend (no extra web server needed).

### Trying the guarded checkout UI
1. Open `http://localhost:4000/demo/checkout?saleId=SALE-1001&clerkId=bartender-7` (preferred) or load `frontend/checkout.html` directly in a browser (Chrome or Edge kiosk mode recommended).
2. Provide tender context via the query string, e.g.:
   ```
   file:///.../frontend/checkout.html?saleId=SALE-1001&clerkId=bartender-7&type=cash&phone=7135550199&locationId=warehouse&autoClose=true
   ```
   If the page is hosted, it will call `https://<host>/api/...`; when opened from disk it assumes `http://localhost:4000/api`.
3. Scan a driver's license. The mock sale list (seeded in `mockLightspeedClient.js`) accepts any 21+ DOB and blocks underage scans. After a success, click **Complete Sale** to see the simulated completion response.

**Integration parameters**
| Query Param | Description |
|-------------|-------------|
| `saleId` | Lightspeed register sale ID (required). |
| `clerkId` / `employeeID` | Tendering employee identifier (required). |
| `type` | Tender type (`cash` or `card`). Enables auto-close. |
| `phone` / `customerPhone` | Customer phone number (optional; displayed to clerk). |
| `locationId` / `outletId` | Outlet slug/ID; drives compliance reporting. |
| `autoClose` | `true` to close the window after successful completion (defaults to `true` when `type` is provided). |
| `api` | Override API base URL (for staging vs. production). |

### Swapping in real Lightspeed credentials
- Replace the mock client with a real Lightspeed integration once the back office grants access. The quickest path is to wrap a production implementation behind the same interface exported by `src/mockLightspeedClient.js`.
- Populate these environment vars in `backend/.env`:
  - `LIGHTSPEED_CLIENT_ID`
  - `LIGHTSPEED_CLIENT_SECRET`
  - `LIGHTSPEED_REDIRECT_URI`
  - `LIGHTSPEED_REFRESH_TOKEN` (after the initial OAuth exchange)
  - Outlet mapping via `LIGHTSPEED_OUTLET_ID_*` plus a fallback `LIGHTSPEED_DEFAULT_OUTLET_ID` (used when kiosks do not supply `X-Location-Id`).
  - Payment method mappings (`LIGHTSPEED_PAYMENT_TYPE_ID_CASH`, `LIGHTSPEED_PAYMENT_TYPE_ID_CARD`) if you plan to post payments during completion.
- Initiate OAuth once per environment by visiting `/api/auth/login?redirect=<return-url>`, signing in with Lightspeed, and confirming the refresh token is written back to the process.
- Leave `LIGHTSPEED_ENABLE_WRITE=false` until you are ready to let the backend create Lightspeed notes/payments; flip it to `true` in staging once the payment type IDs are known.
- Optional: adjust `VERIFICATION_EXPIRY_MINUTES` if policy changes.
- Implement the OAuth exchange and real API calls inside `src/lightspeedXSeriesClient.js` (loaded through `src/lightspeedClient.js`) so the Express routes can remain untouched.
- Use the admin console at `/admin` to monitor token status, trigger a manual refresh, or launch the Lightspeed OAuth login flow.
- CLI helpers: `npm run oauth:status` (inspect current token state) and `npm run oauth:refresh` (force refresh + print result).

### Compliance database (Postgres)
1. Create a Postgres database (Vercel ➝ Storage ➝ Postgres works out of the box).
2. Export the connection string to `DATABASE_URL` (add to Vercel + local `.env`).
3. Seed the schema:
   ```bash
   psql "$DATABASE_URL" -f backend/src/schema.sql
   ```
4. Apply any pending migrations:
   ```bash
   npm run migrate
   ```
   The helper records filenames in `schema_migrations`, so reruns are safe.
5. Optional demo data:
   ```bash
   psql "$DATABASE_URL" -c "INSERT INTO verifications (verification_id, sale_id, clerk_id, age, status) VALUES ('VER-DEMO', 'SALE-1001', 'demo-clerk', 28, 'approved') ON CONFLICT DO NOTHING;"
   ```

The backend persists every verification in `verifications` and links completions in `sales_completions`. If `DATABASE_URL` is missing the API falls back to the in-memory mock and the compliance endpoints respond with `503`.

### New API surface
- `GET /api/reports/overrides?days=30&limit=200` � recent manager overrides with clerk/document context for compliance spot checks.
- `GET /api/reports/compliance?days=30&limit=50` – summary counts, leading rejection reasons, recent activity, and 14-day daily stats (drives the compliance card on the UI).
- `POST /api/sales/:saleId/verify` – now writes to Postgres (IP, user agent, optional `X-Location-Id` header).
- `POST /api/sales/:saleId/complete` – records the completion in `sales_completions` alongside the Lightspeed call.

### Security hardening
- Add `API_SECRET_KEY` in every environment and include `X-API-Key` on kiosk requests; when unset (local dev) the API runs in permissive mode and logs a warning.
- Configure `ALLOWED_ORIGINS` (comma-separated list) if you need to permit hosting domains beyond the local defaults.
- `/api` endpoints are protected with CORS, rate limiting, and request validation (`express-validator`) so bogus input is rejected before it reaches the data layer.

### Vercel deployment checklist
1. `DATABASE_URL` and `API_SECRET_KEY` added under **Settings → Environment Variables** (Development, Preview, Production).
2. Optional: `X-Location-Id` header from your kiosk launcher so verifications are location-aware.
3. Run `npx vercel --prod` (or push to `main`) – the serverless function lives in `api/index.js` and uses the shared Express app.

### Error handling & observability notes
- Requests are logged through `pino-http`; upgrade log shipping by pointing `LOG_LEVEL` and transports at your observability stack.
- Verification failures return HTTP 4xx with machine-readable error codes (`VERIFICATION_EXPIRED`, `VERIFICATION_NOT_APPROVED`, etc.). Frontend uses those messages today; keep them stable for POS alerts.
- When `DATABASE_URL` is present, every verification and sale completion is written to Postgres for audit purposes; without it the server falls back to the in-memory mock store.

### Retention enforcement
- Run `node scripts/enforceRetention.js` to prune historical verifications, overrides, and sale completions.
- Configure retention windows via `RETENTION_DAYS`, `RETENTION_OVERRIDES_DAYS`, and `RETENTION_COMPLETIONS_DAYS` (defaults to 365 days).
- Schedule the script (cron/Vercel job) after verifying it succeeds against staging data.

### Automated smoke test
- `npm run smoke` exercises health, verification, completion, banned lookup, and report endpoints end-to-end against the Express app.
- The runner defaults to the mock Lightspeed client and disables the compliance database to keep it self-contained. Set `SMOKE_USE_REAL_LIGHTSPEED=true SMOKE_LOCATION_ID=<outlet-id>` (and optionally `SMOKE_PAYMENT_TYPE=card`) before running if you want to hit the live APIs with location assertions. Use `SMOKE_USE_DATABASE=true` when you want to test persistence into Postgres.
- Use `SMOKE_SKIP_BANNED=true` when the compliance tables are migrating or unavailable (the script will otherwise treat `/api/banned` failures as fatal).
- The script honours `API_SECRET_KEY` and will attach it automatically when present so you test the authenticated path.

### Next integration steps
1. Wire a real Lightspeed OAuth client and persist tokens securely.
2. Replace the mock completion call with actual `SalePayment`/`Sale` updates and add rollback logic for partial failures.
3. Build a thin launcher (Lightspeed Custom Button) that opens `checkout.html?saleId={{saleID}}&clerkId={{employeeID}}`.
4. Harden the kiosk: run the UI in fullscreen, disable browser nav shortcuts, and document fallback steps if the scanner or network fails.
5. Extended logging: push verification attempts and overrides into a dedicated audit store and alert when a sale sits unverified for more than 15 minutes.

Use this scaffolding to demo the experience to the THC Club owners, then swap the mock pieces for real Lightspeed calls once the API client details are issued.

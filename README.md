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
2. Provide a sale id and clerk id in the query string, e.g.:
   ```
   file:///.../frontend/checkout.html?saleId=SALE-1001&clerkId=bartender-7
   ```
   If the page is hosted, it will call `https://<host>/api/...`; when opened from disk it assumes `http://localhost:4000/api`.
3. Scan a driver's license. The mock sale list (seeded in `mockLightspeedClient.js`) accepts any 21+ DOB and blocks underage scans. After a success, click **Complete Sale** to see the simulated completion response.

### Swapping in real Lightspeed credentials
- Replace the mock client with a real Lightspeed integration once the back office grants access. The quickest path is to wrap a production implementation behind the same interface exported by `src/mockLightspeedClient.js`.
- Populate these environment vars in `backend/.env`:
  - `LIGHTSPEED_CLIENT_ID`
  - `LIGHTSPEED_CLIENT_SECRET`
  - `LIGHTSPEED_REDIRECT_URI`
  - `LIGHTSPEED_REFRESH_TOKEN` (after the initial OAuth exchange)
  - Optional: adjust `VERIFICATION_EXPIRY_MINUTES` if policy changes.
- Implement the OAuth exchange and real API calls inside a new client module (e.g. `src/lightspeedClient.js`) and conditionally load it in `src/routes.js` based on whether credentials are present.

### Error handling & observability notes
- Requests are logged through `pino-http`; upgrade log shipping by pointing `LOG_LEVEL` and transports at your observability stack.
- Verification failures return HTTP 4xx with machine-readable error codes (`VERIFICATION_EXPIRED`, `VERIFICATION_NOT_APPROVED`, etc.). Frontend uses those messages today; keep them stable for POS alerts.
- The mock client stores verification history in memory. For production swap this with a database table keyed by sale id and verification id so you retain audit trails for THC compliance.

### Next integration steps
1. Wire a real Lightspeed OAuth client and persist tokens securely.
2. Replace the mock completion call with actual `SalePayment`/`Sale` updates and add rollback logic for partial failures.
3. Build a thin launcher (Lightspeed Custom Button) that opens `checkout.html?saleId={{saleID}}&clerkId={{employeeID}}`.
4. Harden the kiosk: run the UI in fullscreen, disable browser nav shortcuts, and document fallback steps if the scanner or network fails.
5. Extended logging: push verification attempts and overrides into a dedicated audit store and alert when a sale sits unverified for more than 15 minutes.

Use this scaffolding to demo the experience to the THC Club owners, then swap the mock pieces for real Lightspeed calls once the API client details are issued.

## THC Club ID Scanner – Pilot Runbook

### 1. Environment Setup
1. **Backend**
   - Ensure `.env` has `DATABASE_URL`, `LIGHTSPEED_API_KEY`, `LIGHTSPEED_ACCOUNT_ID`.
   - Map outlet IDs via the `LIGHTSPEED_OUTLET_ID_*` keys and set `LIGHTSPEED_DEFAULT_OUTLET_ID` to the warehouse register you are targeting (used as a fallback when kiosks do not send `X-Location-Id`).
   - Capture payment method IDs from Lightspeed and store them in `LIGHTSPEED_PAYMENT_TYPE_ID_CASH` / `LIGHTSPEED_PAYMENT_TYPE_ID_CARD`. Leave `LIGHTSPEED_ENABLE_WRITE=false` until you are ready for the API to create notes/payments automatically.
   - Kick off the Lightspeed OAuth handshake once per environment: open `https://<backend-host>/api/auth/login?redirect=<return-url>` in a browser, sign in, and capture the refresh token written back into the process (temporarily stored in memory and `.env` for now).
   - Visit `https://<backend-host>/admin` for a quick health dashboard (mode, token expiry, refresh button, and OAuth launch shortcut).
   - Run migrations (one time per environment):
     ```bash
     psql "$DATABASE_URL" -f backend/src/schema.sql
     npm run migrate
     ```
   - Start the server (local sample):
     ```powershell
     $env:PORT = 4200
     npm run start
     ```
2. **Kiosk Client**
   - Launch via Lightspeed custom button:
     ```
     https://<backend-host>/demo/checkout?saleId={{saleID}}&clerkId={{employeeID}}&type={{paymentType}}
     ```
   - Verified in-browser path: `http://localhost:4200/demo/checkout?...`.
   - Optional query params:
     - `phone=` (customer phone number to display in the scanner)
     - `locationId=` / `outletId=` (register outlet identifier for compliance records)
     - `autoClose=true` (close the scanner window automatically after success; defaults to `true` when `type` is provided)
     - `api=` (override API base when pointing at staging vs. production)
3. **API Key (optional)**
   - Set `API_SECRET_KEY` in backend env.
   - Provide kiosks with corresponding `apiKey` query param when loading the checkout page.

### 1.1 Warehouse End-to-End Loop (staging hardware)
- Confirm the warehouse outlet is configured as `LIGHTSPEED_DEFAULT_OUTLET_ID` (or pass `SMOKE_LOCATION_ID`) so the backend can map verifications to the correct store.
- Run `npm run smoke` with `SMOKE_USE_REAL_LIGHTSPEED=true SMOKE_LOCATION_ID=<warehouse-outlet-id>` to exercise the Lightspeed sandbox/warehouse sale end-to-end (verification + completion). The script now asserts location metadata and will fail fast if tokens or outlet mapping are misconfigured.
- After smoke succeeds, launch the kiosk via the Lightspeed custom button and run a manual scan/complete cycle against an open warehouse sale (see Section 3 below for the clerk flow).

### 1.2 Nightly OAuth Check
- Run `npm run oauth:status` (or `npm run oauth:refresh` to force a refresh) from any environment to print token mode, expiry, and write-status.
- Visit `https://<backend-host>/admin` for a quick health dashboard (mode, token expiry, refresh button, and OAuth launch shortcut). Add this to the nightly checklist so tokens never expire unnoticed.

### 2. Daily Opening Checklist
- Confirm kiosk device has stable Wi-Fi and camera lens is clean.
- Visit `/api/health` from a workstation: `curl http://<host>:4200/api/health` – expect `status: ok`, `database: ok`.
- Run a test scan (internal ID) to confirm success + compliance record written.
- Review `/api/banned` to ensure the banned list is current.

### 3. Clerk Workflow Summary
1. Clerk launches the kiosk (fullscreen, limited to single tab).
2. Position ID 4–6 inches away; pass either PDF417 barcode or MRZ lines across camera.
3. System displays age result + instructions:
   - **Green** → sale completes automatically in 2 seconds.
   - **Red** → follow screen guidance (banned, underage, or manual entry). Use **Help** or **Manual Entry** buttons for SOP reminders.
4. If flagged as *Banned ID*:
   - Stop sale immediately.
   - Notify manager; manager decides whether to override (future feature) or refuse sale.
   - Use `Scan Another ID` once resolved.

### 4. Manual Entry / Outage SOP
- If scanner fails after two attempts, tap **Manual Entry**:
  1. Collect customer details, confirm age manually.
  2. Record ID info directly in Lightspeed and create a compliance note.
- If backend is offline:
  - Switch to paper log or emergency spreadsheet.
  - Capture ID manually, then re-enter once system is back.
  - Inform IT if downtime exceeds 5 minutes.

### 5. Banned Customer Management
- Add/remove entries via the protected endpoints:
  ```bash
  # Add
  curl -X POST http://<host>:4200/api/banned -H "Content-Type: application/json" -d '{...}'

  # View
  curl http://<host>:4200/api/banned

  # Delete
  curl -X DELETE http://<host>:4200/api/banned/<id>
  ```
- Review the banned list weekly with compliance leadership.

### 6. Logging & Monitoring
- All verification attempts (approved/rejected/banned) land in Postgres (`verifications`, `banned_customers`).
- Server logs highlight:
  - `verification_attempt`
  - `banned_customer_attempt`
  - API errors (Lightspeed, DB)
- Recommended alerts:
  - High rate of rejections/scan failures.
  - Any banned attempt (notify compliance).

### 7. Troubleshooting Quick Guide
| Symptom | Suggested Action |
|---------|------------------|
| Camera feed frozen | Tap **Restart Scan**, or refresh kiosk page. If persistent, reboot device. |
| Repeated scan failures | Clean lens, improve lighting, switch to manual entry, then report to IT. |
| Sales not completing | Check `/api/health` and Postgres connectivity; verify Lightspeed credentials not expired. |
| Banned ID still completing | Confirm banned record exists (matching document number + country), restart backend to reload config. |

### 8. Pilot Reporting
- Export compliance data via `/api/reports/compliance?days=30`.
- Cross-check daily count of verifications vs. Lightspeed sales to ensure coverage > 99%.
- After pilot, summarize incidents (banned IDs caught, manual overrides, scanner errors) for leadership review.

### 9. Manager Override Flow
1. When the kiosk flags an ID (underage/banned scan), the **Manual Entry** button becomes available.
2. Clerk taps Manual Entry and calls a manager. Manager enters PIN + reason.
3. Backend records the override (`verification_overrides`) and marks the verification `approved_override`.
4. Kiosk switches to green and allows the sale to complete.
5. Compliance reviews override notes during daily/weekly audits.

> Keep the manager PIN rotated periodically and store it securely (e.g., secret vault).

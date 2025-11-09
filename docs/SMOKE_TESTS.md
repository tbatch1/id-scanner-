# Automated Smoke Tests

These lightweight checks run the kiosk workflow against the Express app with zero external setup. Run them before every deploy (staging and production) and hook them into a nightly job so regressions surface quickly.

> Quick run: `npm run smoke` (in-process via `scripts/runSmoke.js`).

## Runtime controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `SMOKE_USE_REAL_LIGHTSPEED` | `false` | Leave `false` to exercise the in-memory Lightspeed mock. Set to `true` when you are ready to hit the live Retail API. |
| `SMOKE_USE_DATABASE` | `false` | Leave `false` while migrations are in flight. Set to `true` after the compliance schema is stable to ensure Postgres writes succeed. |
| `SMOKE_SKIP_BANNED` | `false` | Set to `true` if the banned-customer tables are offline so the run records a skip instead of failing. |
| `SMOKE_SALE_ID` / `SMOKE_BANNED_SALE_ID` | `SALE-1001` / `SALE-1002` | Override with deterministic sale IDs that exist in staging or production. |
| `SMOKE_OVERRIDE_PIN` | unset | Provide to exercise the manager override flow during the run. |

When `API_SECRET_KEY` is defined the runner automatically attaches it, so the authenticated path is covered. Supertest executes requests in-process, meaning the backend does not need to be running separately.

## Sequence covered

1. **Health check** - `/api/health` responds with `status: ok`.  
2. **Happy-path verification** - `/api/sales/:saleId/verify` accepts a 21+ scan and returns a `verificationId`.  
3. **Manager override (optional)** - `/api/sales/:saleId/override` runs when `SMOKE_OVERRIDE_PIN` is available.  
4. **Banned lookup** - `/api/banned` plus `/verify` re-run to confirm a banned document blocks the sale (skipped if the database is disabled).  
5. **Compliance reports** - `/api/reports/compliance` and `/api/reports/overrides` succeed or return a clear 503 when storage is intentionally offline.

## Failure handling

- The script throws on the first unexpected status code or missing field; the process exits `1` so CI/CD jobs halt immediately.  
- Keep the terminal output with the deployment record so the team can see which step failed.  
- If you run with `SMOKE_USE_DATABASE=true` and persistence fails, open an incident - compliance storage may be at risk.

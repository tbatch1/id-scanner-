# Production Rollout Playbook

## 1. Pre-Prod Checklist
1. Apply all migrations against production Postgres (schema + identity metadata).
2. Verify `.env` contains production Lightspeed OAuth credentials, `API_SECRET_KEY`, `ALLOWED_ORIGINS`, retention env vars.
3. Smoke test staging checklist one more time (scan, override, banned, retention job).

## 2. Cutover Steps
1. Pause sales at pilot location for 15 minutes (to avoid in-flight transactions).
2. Deploy backend with production env vars (`npm run start` or Vercel deploy).
3. Run smoke test on production (known test ID, override, banned record).
4. Flip kiosk launchers to production URL.
5. Monitor logs & health endpoints for first hour.

## 3. Rollback Strategy
- Keep pilot/staging backend running; if production issues arise:
  1. Point kiosk back to staging URL.
  2. Restore previous deployment (git tag/commit).
  3. Investigate logs; only retry once clear RCA.

## 4. Post-Launch Monitoring
1. Alert channels active for verification failures, banned attempts, retention errors.
2. Daily sales vs. verifications reconciliation.
3. Review override report each morning; ensure notes/pins rotated weekly.

## 5. Operations Hand-off
- Provide clerk training + kiosk manual.
- Document emergency manual verification SOP.
- Schedule retention job + banned list review (weekly).
- Confirm compliance exports (monthly) are automated.


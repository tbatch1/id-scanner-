# THC Club Pilot Readiness Checklist

## A. Staging Hardware Prep
1. Verify kiosk device has clean Windows updates, disabled sleep, and admin lockout.
2. Install/verify camera drivers and test webcam feed (Windows Camera app).
3. Confirm kiosk browser (Edge/Chrome) auto-launches `demo/checkout` with sale/clerk placeholders.
4. Pair scanner station with UPS / surge protector.

## B. Backend Staging Configuration
1. Set `DATABASE_URL`, `API_SECRET_KEY`, `ALLOWED_ORIGINS`, and Lightspeed creds in `.env`.
2. Run migrations:
   ```bash
   psql "$DATABASE_URL" -f backend/src/schema.sql
   npm run migrate
   ```
3. Seed pilot clerk + banned test records if needed.
4. Schedule retention cron on staging (`node scripts/enforceRetention.js`).

## C. Observability & Alerts
1. Wire backend logs to monitoring (e.g., Datadog, CloudWatch) via `LOG_LEVEL` + transport.
2. Configure alerts for:
   - Repeated `verification_failure` or `manual_override` events in < 10 min window.
   - `banned_customer_attempt` occurrences.
   - Retention job failures.
3. Ensure `/api/health` and `/api/reports/compliance` are integrated into uptime checks.

## D. Pilot Day Opening Checklist
- [ ] Kiosk powers on and launches checkout page automatically.
- [ ] Run test scan with internal ID (should auto-complete > 21).
- [ ] Confirm compliance record appears (`/api/reports/compliance?days=1`).
- [ ] Verify override flow with staging PIN and review `/api/reports/overrides`.
- [ ] Sync latest banned list via `/api/banned`.

## E. Incident Logging Template
```
Date/Time:
Location:
Clerk ID:
Issue Type (Scan failure / Override / Banned / System outage):
ID Type (DL, Passport, other):
Action Taken:
Follow-up Needed:
```

## F. Post-Pilot Wrap Up
1. Export 30-day compliance report + override report for leadership review.
2. Summarize incidents, manual overrides, and downtime.
3. Update banned list / SOPs based on lessons learned.
4. Adjust retention windows or alerts as required before production rollout.


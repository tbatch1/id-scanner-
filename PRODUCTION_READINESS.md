# PRODUCTION READINESS - THC Club ID Scanner
## 18-Location Deployment Requirements

**Last Updated**: November 22, 2025
**Status**: ⚠️ NOT PRODUCTION-READY
**Target**: 18 THC Club Dispensaries

---

## 🚨 CRITICAL DEPLOYMENT BLOCKERS

### 1. Dynamsoft Production License - **REQUIRED**
- **Status**: ❌ Using trial license (expires in ~30 days)
- **Impact**: Scanner stops working at ALL 18 locations when trial expires
- **Cost**: $1,500-3,000/year
- **Action Required**:
  1. Purchase from https://www.dynamsoft.com/customer/order/create
  2. Select "Barcode Reader" + "Code Parser"
  3. Choose "Annual License" for JavaScript
  4. Update license key in `frontend/scanner.html` line 568
  5. Deploy to production
- **Lead Time**: 1-2 business days
- **Priority**: P0 - Cannot deploy without this

### 2. Neon Database Upgrade - **REQUIRED**
- **Status**: ❌ Using free tier with cold starts
- **Impact**: 10-second delays on first scan after 5 min of inactivity
- **Frequency**: ~180 slow scans per day (10 per location)
- **Cost**: $69/month ($828/year)
- **Action Required**:
  1. Log into https://neon.tech/
  2. Navigate to project settings
  3. Upgrade to "Scale" plan
  4. Confirm payment method
- **Benefits**:
  - Eliminates cold starts (instant response)
  - Higher connection limits
  - Daily automatic backups
  - 99.95% uptime SLA
- **Priority**: P0 - Critical for user experience

### 3. Database Connection Pool - **REQUIRED**
- **Status**: ✅ PARTIALLY FIXED (timeout increased to 10s)
- **Remaining Issue**: Pool size = 20, needed = 40
- **Impact**: Connection exhaustion during peak hours (lunch/dinner)
- **Cost**: FREE (code change only)
- **Action Required**:
  ```javascript
  // File: backend/src/db.js line 45
  max: 40,  // Change from 20 to 40
  ```
- **Deploy**: Redeploy to Vercel after change
- **Priority**: P0 - Will fail at scale

### 4. Production Monitoring - **REQUIRED**
- **Status**: ❌ No monitoring configured
- **Impact**: No visibility into production failures
- **Cost**: $0-26/month
- **Action Required**:

  **A. UptimeRobot (FREE)**:
  1. Sign up at https://uptimerobot.com/
  2. Add HTTP monitor: `https://your-app.vercel.app/api/health`
  3. Set check interval: 5 minutes
  4. Configure email alerts

  **B. Sentry Error Tracking ($26/month)**:
  1. Sign up at https://sentry.io/ (Team plan)
  2. Create new project (Node.js)
  3. Get DSN key
  4. Add to backend:
     ```javascript
     // backend/src/app.js (top of file)
     const Sentry = require('@sentry/node');
     Sentry.init({ dsn: process.env.SENTRY_DSN });

     // Add after Express app creation
     app.use(Sentry.Handlers.requestHandler());

     // Add before other error handlers
     app.use(Sentry.Handlers.errorHandler());
     ```
  5. Set `SENTRY_DSN` in Vercel environment variables
  6. Deploy
- **Priority**: P0 - Cannot fly blind

---

## 🔴 HIGH PRIORITY (Launch Week)

### 5. API Authentication
- **Status**: ⚠️ Optional (if API_SECRET_KEY not set)
- **Impact**: Public API = anyone can fake verification records
- **Cost**: FREE
- **Action Required**:
  1. Generate secure key:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
  2. Set in Vercel environment variables:
     ```
     API_SECRET_KEY=<generated-key>
     ```
  3. Update frontend to send Authorization header (if needed)
- **Priority**: P1 - Security risk

### 6. Admin Route Authentication
- **Status**: ❌ Admin routes are public
- **Impact**: Anyone can access /admin/scans, /admin/banned, etc.
- **Cost**: FREE
- **Action Required**:
  1. Generate admin token:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
  2. Set in Vercel:
     ```
     ADMIN_TOKEN=<generated-token>
     ```
  3. Add middleware to `backend/src/app.js`:
     ```javascript
     const adminAuth = (req, res, next) => {
       const token = req.headers['x-admin-token'];
       if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
         return res.status(401).json({ error: 'Unauthorized' });
       }
       next();
     };

     app.use('/admin', adminAuth, adminRoutes);
     ```
- **Priority**: P1 - Security risk

### 7. Rate Limiter Fix (strictLimiter)
- **Status**: ⚠️ Too restrictive for 18 locations
- **Current**: 30 requests per 15 minutes
- **Impact**: Rate limit triggers after 30 scans across ALL locations
- **Cost**: FREE
- **Action Required**:
  ```javascript
  // File: backend/src/app.js lines 73-89
  const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,  // Increase from 30 to 200
    // OR add IP whitelist:
    skip: (req) => {
      const storeIPs = process.env.STORE_IP_WHITELIST?.split(',') || [];
      return storeIPs.includes(req.ip);
    }
  });
  ```
- **Priority**: P1 - Will block legitimate traffic

### 8. TABC Compliance - Data Retention
- **Status**: ❌ Default retention = 365 days (violates 2-year requirement)
- **Required**: 730 days per TABC regulations
- **Penalty**: $500-10,000 per violation
- **Cost**: FREE
- **Action Required**:
  ```javascript
  // File: backend/src/complianceStore.js line 538
  async function enforceRetention({
    verificationDays = 730,  // Change from 365 to 730
    // ...
  ```
- **Priority**: P1 - Legal compliance

### 9. Schedule Data Retention Job
- **Status**: ❌ Retention function exists but never runs
- **Cost**: FREE (included in Vercel Pro)
- **Action Required**:
  1. Add to `vercel.json`:
     ```json
     {
       "crons": [{
         "path": "/api/admin/enforce-retention",
         "schedule": "0 2 * * *"
       }]
     }
     ```
  2. Create endpoint in `backend/src/routes.js`:
     ```javascript
     router.post('/admin/enforce-retention', async (req, res) => {
       const result = await complianceStore.enforceRetention({
         verificationDays: 730
       });
       logger.info({ event: 'retention_enforced', ...result });
       res.json(result);
     });
     ```
- **Priority**: P1 - Automate compliance

### 10. CORS Whitelist for Production
- **Status**: ⚠️ Development mode allows all origins
- **Cost**: FREE
- **Action Required**:
  ```bash
  # In Vercel environment variables
  ALLOWED_ORIGINS=https://your-vercel-app.vercel.app,https://custom-domain.com
  ```
- **Priority**: P1 - Security

---

## 🟡 MEDIUM PRIORITY (Month 1)

### 11. Vercel Plan Confirmation
- **Status**: ❓ Unknown (likely Hobby)
- **Required**: Pro plan minimum ($20/month)
- **Benefits**: 1000GB-hours, 100 concurrent, 60s timeout
- **Action**: Verify current plan, upgrade if needed

### 12. TABC Export Endpoint
- **Status**: ❌ Missing
- **Need**: CSV export for TABC inspections
- **Cost**: FREE
- **Action Required**:
  ```javascript
  // File: backend/src/routes.js
  router.get('/admin/export/tabc', async (req, res) => {
    const { start_date, end_date } = req.query;
    const { rows } = await db.query(`
      SELECT * FROM compliance_report
      WHERE verified_at BETWEEN $1 AND $2
      ORDER BY verified_at DESC
    `, [start_date, end_date]);

    // Convert to CSV
    const csv = convertToCSV(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=tabc-report.csv');
    res.send(csv);
  });
  ```

### 13. Override PIN Rate Limiting
- **Status**: ❌ Unlimited brute force attempts
- **Impact**: Single PIN can be guessed
- **Cost**: FREE
- **Action Required**:
  ```javascript
  const overrideLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => req.ip + ':' + req.params.saleId
  });

  app.post('/api/sales/:saleId/override', overrideLimiter, ...);
  ```

### 14. Database Query Retry Logic
- **Status**: ❌ No retries on transient failures
- **Cost**: FREE
- **Action Required**:
  ```javascript
  // File: backend/src/db.js
  async function queryWithRetry(text, params, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await pool.query(text, params);
      } catch (error) {
        if (attempt === maxRetries - 1) throw error;
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  ```

### 15. Frontend Fetch Timeout
- **Status**: ❌ No timeout (hangs indefinitely on network failure)
- **Cost**: FREE
- **Action Required**:
  ```javascript
  // File: frontend/scanner.html saveScanResult()
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const response = await fetch('/api/scan-sessions', {
    signal: controller.signal,
    // ...
  });
  clearTimeout(timeout);
  ```

### 16. Crypto-Secure Session IDs
- **Status**: ⚠️ Uses Math.random() (predictable)
- **Cost**: FREE
- **Action Required**:
  ```javascript
  // File: frontend/scanner.html line 545
  const sessionId = urlParams.get('session_id') ||
                    urlParams.get('sale_id') ||
                    crypto.randomUUID();
  ```

---

## 📊 TESTING REQUIREMENTS

### Load Testing Script
```bash
#!/bin/bash
# Test 50 concurrent database connections

for i in {1..50}; do
  curl -X POST https://your-app.vercel.app/api/scan-sessions \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_SECRET_KEY" \
    -d '{
      "sessionId": "LOAD-TEST-'$i'",
      "approved": true,
      "firstName": "Test",
      "lastName": "User",
      "age": 25,
      "dob": "1998-01-01",
      "documentType": "drivers_license"
    }' &
done

wait
echo "Load test complete"
```

**Expected Result**: All 50 requests succeed
**With Current Pool (20)**: ~30 will fail
**With Fixed Pool (40)**: All should succeed

### Cold Start Test
```bash
# Test Neon database cold start
echo "Waiting 10 minutes for database to pause..."
sleep 600

# Trigger scan
curl https://your-app.vercel.app/api/scan-sessions \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"COLD-START-TEST",...}'

# Measure response time
```

**Expected (Free Tier)**: 10-15 second response
**Expected (Paid Tier)**: <1 second response

### Scanner Functionality Test
1. Open scanner on iPad
2. Click "START CAMERA"
3. Scan valid ID
4. Verify:
   - ✅ Camera opens within 5 seconds
   - ✅ Barcode detected within 2 seconds
   - ✅ Database save completes within 3 seconds
   - ✅ Shows "✅ Verified! Click Close Scanner to return"
   - ✅ Data appears in database

---

## 💰 COST SUMMARY

### Year 1 Costs
```
CRITICAL (Required):
Dynamsoft License         $2,000 (one-time)
Neon Scale                $828/year ($69/month)
UptimeRobot               $0/year (free)

HIGH PRIORITY (Recommended):
Vercel Pro                $240/year ($20/month)
Sentry Team               $312/year ($26/month)

OPTIONAL:
S3 Backups                $60/year ($5/month)

TOTAL MINIMUM:            $2,828/year
TOTAL RECOMMENDED:        $3,440/year
```

### Per Location Cost
```
18 locations:
Minimum: $2,828 ÷ 18 = $157/location/year ($13/month)
Recommended: $3,440 ÷ 18 = $191/location/year ($16/month)
```

### Per Scan Cost
```
Expected volume: 900 scans/day × 365 = 328,500 scans/year
Cost per scan: $3,440 ÷ 328,500 = $0.0105 (~1 cent)
```

---

## 📋 DEPLOYMENT CHECKLIST

### PRE-DEPLOYMENT
- [ ] Purchase Dynamsoft production license
- [ ] Upgrade Neon database to Scale plan
- [ ] Set API_SECRET_KEY in Vercel
- [ ] Set ADMIN_TOKEN in Vercel
- [ ] Increase DB connection pool to 40
- [ ] Fix strictLimiter rate limit
- [ ] Set up UptimeRobot monitoring
- [ ] Set up Sentry error tracking
- [ ] Fix TABC data retention (730 days)
- [ ] Schedule retention cron job
- [ ] Set ALLOWED_ORIGINS for production
- [ ] Run load test (50 concurrent)
- [ ] Test database cold start
- [ ] Test scanner end-to-end

### PILOT DEPLOYMENT (Week 1)
- [ ] Deploy to 3 test locations
- [ ] Monitor Sentry dashboard 3x/day
- [ ] Check UptimeRobot status
- [ ] Gather staff feedback
- [ ] Verify database connection pool stats
- [ ] Review error logs daily
- [ ] Test scanner at each location

### GRADUAL ROLLOUT (Week 2-3)
- [ ] Deploy to 6 more locations (total 9)
- [ ] Monitor error rate (<1% target)
- [ ] Check scan success rate (>98% target)
- [ ] Verify average scan time (<5s target)
- [ ] Deploy to remaining 9 locations
- [ ] Full production monitoring

### POST-LAUNCH (Ongoing)
- [ ] Daily: Check Sentry dashboard
- [ ] Daily: Verify UptimeRobot status
- [ ] Weekly: Review database backup
- [ ] Weekly: Export compliance report
- [ ] Monthly: Review performance metrics
- [ ] Quarterly: Test disaster recovery
- [ ] Annually: Renew Dynamsoft license

---

## 🎯 SUCCESS METRICS

### Target KPIs
- **Uptime**: >99.5% (max 4 hours downtime/month)
- **Scan Success Rate**: >98%
- **Average Scan Time**: <5 seconds (camera to database)
- **Database Query Latency**: <200ms average
- **Error Rate**: <1% of all scans
- **TABC Compliance**: 100% (all scans recorded, 2-year retention)

### Monitoring Dashboards
1. **UptimeRobot**: https://uptimerobot.com/dashboard
2. **Sentry**: https://sentry.io/organizations/your-org/issues/
3. **Vercel**: https://vercel.com/dashboard
4. **Neon**: https://console.neon.tech/

---

## 🚨 KNOWN ISSUES

### Critical
1. **Dynamsoft Trial Expires**: ~30 days remaining
2. **Database Cold Starts**: 10s delay on Neon free tier
3. **Connection Pool Undersized**: 20 vs 40 needed
4. **No Production Monitoring**: Flying blind

### High
5. **No API Authentication**: Public API if not configured
6. **Admin Routes Public**: No authentication
7. **Rate Limiter Too Strict**: 30 req/15min for all locations
8. **TABC Retention Wrong**: 365 days vs 730 required

### Medium
9. **No Retry Logic**: Database queries fail on transient errors
10. **No Fetch Timeout**: Hangs on network failures
11. **Weak Session IDs**: Uses Math.random()
12. **No Override PIN Limit**: Unlimited brute force attempts

---

## 📞 EMERGENCY CONTACTS

### Vendor Support
- **Dynamsoft**: support@dynamsoft.com (license issues)
- **Neon**: support@neon.tech (database issues)
- **Vercel**: support@vercel.com (deployment issues)
- **Sentry**: support@sentry.io (monitoring issues)

### Internal Escalation
- **Development**: [Your contact]
- **Operations**: [Your contact]
- **Compliance**: [Your contact]

---

## 📝 NOTES

### Current State (as of Nov 22, 2025)
- ✅ Scanner functionality working
- ✅ Database timeout increased (10s for cold starts)
- ✅ New Dynamsoft trial license installed
- ✅ Frontend/backend integration complete
- ⚠️ Running on trial/free tier infrastructure
- ⚠️ No production monitoring configured
- ❌ Not ready for 18-location deployment

### Recent Changes
- Nov 22: Increased DB timeout from 2s to 10s (Neon cold start fix)
- Nov 22: Updated Dynamsoft license (new trial)
- Nov 22: Fixed scanner completion flow (stop camera, show success)
- Nov 22: Implemented closeScanner() return to POS functionality

### Next Steps
1. **Immediate**: Test current scanner functionality
2. **This Week**: Purchase Dynamsoft license + upgrade Neon
3. **Next Week**: Set up monitoring, deploy to pilot locations
4. **Week 3**: Gradual rollout to all 18 locations

---

**Last Updated**: November 22, 2025
**Document Owner**: Development Team
**Review Frequency**: Weekly until full deployment, then monthly

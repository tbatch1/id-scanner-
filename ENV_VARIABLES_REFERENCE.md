# Environment Variables Quick Reference

## 🔑 Generate Security Keys

Run these commands to generate secure random keys:

```bash
# Generate API_SECRET_KEY
node -e "console.log('API_SECRET_KEY=' + require('crypto').randomBytes(32).toString('hex'))"

# Generate ADMIN_TOKEN
node -e "console.log('ADMIN_TOKEN=' + require('crypto').randomBytes(32).toString('hex'))"

# Generate CRON_SECRET
node -e "console.log('CRON_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

---

## 📋 Complete Variable List for Vercel

Copy and paste these into Vercel Dashboard → Settings → Environment Variables:

### Required Variables

| Variable Name | Description | How to Get | Example |
|--------------|-------------|------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Neon Dashboard → Connection Details | `postgresql://user:pass@host/db` |
| `API_SECRET_KEY` | API authentication | Generate with crypto | `a1b2c3d4e5f6...` (64 chars) |
| `ADMIN_TOKEN` | Admin dashboard auth | Generate with crypto | `f6e5d4c3b2a1...` (64 chars) |

### Optional but Recommended

| Variable Name | Description | Example |
|--------------|-------------|---------|
| `CRON_SECRET` | Cron job protection | `7a8b9c0d1e2f...` (64 chars) |
| `ALLOWED_ORIGINS` | CORS whitelist | `https://your-app.vercel.app` |
| `OPENAI_API_KEY` | Enables manager AI chat | `sk-...` |
| `OPENAI_MODEL` | AI model name (default `gpt-5-nano`) | `gpt-5-nano` |
| `OPENAI_FALLBACK_MODELS` | Comma-separated fallback models | `gpt-4.1-nano,gpt-4o-mini` |
| `OPENAI_MAX_OUTPUT_TOKENS` | Cap AI response length | `1024` |
| `LIGHTSPEED_CLIENT_ID` | OAuth app client id (recommended for production) | `ls_...` |
| `LIGHTSPEED_CLIENT_SECRET` | OAuth app client secret | `...` |
| `LIGHTSPEED_REDIRECT_URI` | OAuth callback URL (must match exactly in Lightspeed app settings) | `https://id-scanner-project.vercel.app/api/auth/callback` |
| `LIGHTSPEED_OAUTH_SCOPES` | OAuth scopes (space-delimited) | `sales:read sales:write customers:read customers:write webhooks` |
| `LIGHTSPEED_WEBHOOK_STORE_RAW_BODY` | Store raw webhook bodies in DB for debugging (`true`/`false`) | `false` |
| `CRON_DAILY_TIMEZONE` | Timezone for daily heavy tasks (retention/snapshots) | `America/Chicago` |
| `CRON_DAILY_HOUR` | Daily heavy tasks hour (local) | `23` |
| `CRON_DAILY_MINUTE` | Daily heavy tasks minute (local) | `30` |
| `CRON_RUN_SNAPSHOTS` | Run nightly BI snapshots | `true` |
| `CRON_SNAPSHOT_MODE` | Snapshot mode run nightly | `sales` |
| `CRON_RUN_CUSTOMER_SYNC` | Run customer profile sync during the nightly cron tick | `true` |
| `CRON_CUSTOMER_SYNC_MAX_DURATION_MS` | Max time per polling tick | `8000` |
| `CUSTOMER_RECONCILE_DONE_RETENTION_DAYS` | Keep successful customer-autofill jobs (PII wiped) | `3` |
| `CUSTOMER_RECONCILE_PENDING_RETENTION_DAYS` | Keep pending/failed customer-autofill jobs | `2` |
| `SNAPSHOT_DAY_CUTOFF_HOUR` | Local cutoff (hour) for “business day” | `6` |
| `SNAPSHOT_CUSTOMER_LOOKUP_LIMIT` | Max customer lookups per run | `2000` |
| `SNAPSHOT_CUSTOMER_LOOKUP_CONCURRENCY` | Parallel customer lookups | `6` |

### Already Configured (from .env.example)

| Variable Name | Default Value | Description |
|--------------|---------------|-------------|
| `PORT` | `4000` | Server port |
| `NODE_ENV` | `production` | Environment |
| `MINIMUM_AGE` | `21` | Age requirement |
| `VERIFICATION_EXPIRY_MINUTES` | `15` | Session timeout |
| `LOG_LEVEL` | `info` | Logging level |

---

## 🎯 Quick Setup Steps

### 1. Generate All Keys at Once
```bash
echo "=== Copy these to Vercel ==="
echo ""
echo "API_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo "ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo "CRON_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo ""
echo "=== Get DATABASE_URL from Neon Dashboard ==="
```

### 2. Add to Vercel
1. Go to: https://vercel.com/dashboard
2. Select your project
3. Settings → Environment Variables
4. Click "Add New" for each variable
5. Select: Production, Preview, Development (all three)
6. Click "Save"

### 3. Redeploy if Needed
If variables were added after deployment started:
- Deployments tab → Latest deployment → ⋯ → Redeploy

---

## 🧪 Test After Deployment

### Test API Authentication
```bash
# Should return 401 without key (if API_SECRET_KEY is set)
curl https://your-app.vercel.app/api/health

# Should work with key
curl -H "X-API-Key: YOUR_API_SECRET_KEY" https://your-app.vercel.app/api/health
```

### Test Admin Authentication
```bash
# Should return 401 without token (if ADMIN_TOKEN is set)
curl https://your-app.vercel.app/admin/status

# Should work with token
curl -H "X-Admin-Token: YOUR_ADMIN_TOKEN" https://your-app.vercel.app/admin/status
```

### Test Database Connection
```bash
# Check if database is connected
curl https://your-app.vercel.app/api/health
# Response should include: "database": "connected"
```

---

## 🔒 Security Notes

- **Never commit these keys to git**
- **Rotate keys every 90 days**
- **Use different keys for prod/preview/dev**
- **Store backup copy securely** (password manager)

---

## 📞 If Something Goes Wrong

### Database Not Connecting
- Check DATABASE_URL format
- Verify Neon database is active
- Check SSL mode: `?sslmode=require`

### 401 Errors on API
- Verify API_SECRET_KEY is set
- Check header name: `X-API-Key` (case-sensitive)
- Ensure key matches exactly (no spaces)

### Admin Routes Not Working
- Verify ADMIN_TOKEN is set
- Check header name: `X-Admin-Token` (case-sensitive)
- Check browser console for errors

### OAuth Login Not Working
- Set `LIGHTSPEED_CLIENT_ID`, `LIGHTSPEED_CLIENT_SECRET`, `LIGHTSPEED_REDIRECT_URI`
- Ensure `LIGHTSPEED_REDIRECT_URI` matches exactly in the Lightspeed developer app
- Start the flow from `https://your-app.vercel.app/api/auth/login`

### Cron Job Not Running
- Verify CRON_SECRET is set (optional)
- Check Vercel Dashboard → Cron Jobs
- View cron execution logs
- Endpoint: `/api/cron/retention` (runs once/day at 11:30pm CST)
- Marketing customer sync endpoint: `/api/cron/customers` (manual trigger; polling runs via `/api/cron/retention` when `CRON_RUN_CUSTOMER_SYNC=true`)
- Customer autofill reconcile endpoint: `/api/cron/customer-reconcile` (runs frequently; fills loyalty customer fields after scans)
- Webhook processor endpoint: `/api/cron/webhooks` (processes stored webhook events; also triggers customer reconcile)
- For near-real-time polling on Vercel Hobby: use `.github/workflows/customer-sync.yml` to call `/api/cron/customers` every 15 minutes.

---

**Last Updated**: December 3, 2025
**Deployment**: Companion App v1.0

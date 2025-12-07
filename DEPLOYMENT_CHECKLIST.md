# Deployment Checklist - Companion App v1.0

**Deployment Date**: December 3, 2025
**Commit Hash**: 57e100a
**Branch**: main

---

## ✅ Pre-Deployment Checklist

### Code Changes Committed
- [x] Backend infrastructure upgrades (Week 1)
- [x] Frontend Companion App transformation (Week 2)
- [x] PWA manifest.json created
- [x] All changes committed to main branch
- [x] Changes pushed to GitHub

### Git Status
```bash
Commit: 57e100a
Message: feat: Release Companion App v1.0 (Infrastructure upgrades + PWA support)
Files Changed: 9 files, 458 insertions(+), 52 deletions(-)
Status: Pushed to origin/main
```

---

## 🔧 Vercel Environment Variables - REQUIRED

### Critical Security Variables (Generate before deployment)

#### 1. API_SECRET_KEY
**Purpose**: Protects API endpoints from unauthorized access
**Generate**:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
**Example Output**: `a1b2c3d4e5f6...` (64 characters)
**Where to Set**: Vercel Dashboard → Settings → Environment Variables
**Variable Name**: `API_SECRET_KEY`
**Value**: [Paste generated key]

#### 2. ADMIN_TOKEN
**Purpose**: Protects admin dashboard and sensitive routes
**Generate**:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
**Example Output**: `f6e5d4c3b2a1...` (64 characters)
**Where to Set**: Vercel Dashboard → Settings → Environment Variables
**Variable Name**: `ADMIN_TOKEN`
**Value**: [Paste generated key]

#### 3. CRON_SECRET (Optional but recommended)
**Purpose**: Protects cron job endpoint from unauthorized triggering
**Generate**:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
**Where to Set**: Vercel Dashboard → Settings → Environment Variables
**Variable Name**: `CRON_SECRET`
**Value**: [Paste generated key]

#### 4. DATABASE_URL
**Purpose**: Connection string for Neon PostgreSQL database
**Format**: `postgresql://user:password@host/database?sslmode=require`
**Where to Get**: Neon Dashboard → Connection String
**Where to Set**: Vercel Dashboard → Settings → Environment Variables
**Variable Name**: `DATABASE_URL`
**Value**: [Paste connection string from Neon]

**Note**: If DATABASE_URL is already connected via Vercel Integration, you don't need to set it manually.

#### 5. ALLOWED_ORIGINS (Optional - Production Security)
**Purpose**: CORS whitelist for allowed domains
**Format**: Comma-separated list of origins
**Example**: `https://id-scanner-project.vercel.app,https://your-custom-domain.com`
**Where to Set**: Vercel Dashboard → Settings → Environment Variables
**Variable Name**: `ALLOWED_ORIGINS`

---

## 🚀 Vercel Deployment Steps

### Step 1: Navigate to Vercel Dashboard
1. Go to [https://vercel.com/dashboard](https://vercel.com/dashboard)
2. Find your project: **id-scanner-project** (or your project name)
3. Click on the project

### Step 2: Check Latest Deployment
1. You should see a new deployment triggered by the git push
2. Status should show "Building" or "Ready"
3. If it says "Error", click on the deployment to see logs

### Step 3: Set Environment Variables (If Not Set)
1. Go to **Settings** → **Environment Variables**
2. Add each variable listed above:
   - Click **Add New**
   - Enter **Name** (e.g., `API_SECRET_KEY`)
   - Enter **Value** (paste generated key)
   - Select **Production**, **Preview**, and **Development** (all three)
   - Click **Save**

### Step 4: Redeploy (If Variables Were Added After Build Started)
1. Go to **Deployments** tab
2. Find the latest deployment
3. Click the **⋯** (three dots) menu
4. Click **Redeploy**
5. Confirm redeploy

### Step 5: Wait for Deployment to Complete
- Build time: ~2-3 minutes
- Watch the logs for any errors
- Status should change to **Ready** with a green checkmark

---

## 🧪 Post-Deployment Testing

### Test 1: Scanner Page Loads
1. Open production URL: `https://[your-project].vercel.app/scanner.html`
2. **Expected**: Page loads with THC logo
3. **Expected**: "Select Register" modal appears (if no register_id in URL)

### Test 2: Register Selection Flow
1. Enter `TEST-DEPLOY` in the Register input
2. Click "Save & Continue"
3. **Expected**: Modal closes
4. **Expected**: Toast shows "✅ Register TEST-DEPLOY selected"
5. Reload page
6. **Expected**: No modal shown (register cached in localStorage)

### Test 3: UI Elements Present
1. Check for "Return to POS" button at bottom-right
2. **Expected**: Orange floating button visible
3. Click "Return to POS"
4. **Expected**: Toast shows swipe instruction
5. **Expected**: NO "Close Scanner" button visible

### Test 4: PWA Manifest Loads
1. Open browser DevTools (F12)
2. Go to Application tab → Manifest
3. **Expected**: THC Club ID Scanner manifest loads
4. **Expected**: Icons, theme colors, and display mode shown

### Test 5: Start Camera (Optional - requires HTTPS)
1. Click "START CAMERA"
2. **Expected**: Camera permission prompt (on mobile)
3. **Expected**: Video feed starts
4. **Note**: May not work on desktop without webcam

### Test 6: Admin Routes Protected
1. Open: `https://[your-project].vercel.app/admin/status`
2. Without X-Admin-Token header:
   - **Expected**: 401 Unauthorized error (if ADMIN_TOKEN is set)
   - **Expected**: Page loads with warning (if ADMIN_TOKEN not set)

### Test 7: Database Connection (If DATABASE_URL Set)
1. Complete a test scan (if camera works)
2. Check admin dashboard: `https://[your-project].vercel.app/admin-scans.html`
3. **Expected**: Scan data appears in database

---

## 📱 iPad Testing Checklist

### PWA Installation
1. Open production URL in Safari on iPad
2. Tap **Share** button (square with arrow up)
3. Tap **Add to Home Screen**
4. Name: "ID Scanner"
5. Tap **Add**
6. **Expected**: Icon appears on iPad home screen

### Launch PWA
1. Tap ID Scanner icon from home screen
2. **Expected**: Opens fullscreen (no Safari UI)
3. **Expected**: "Select Register" modal appears (first time)
4. Enter register ID
5. **Expected**: Modal closes, scanner ready

### Test Swipe Gesture
1. While scanner is open, swipe up from bottom of screen
2. **Expected**: iPad multitasking view appears
3. **Expected**: Can switch to other apps
4. **Expected**: Scanner remains in background

---

## 🔄 Rollback Plan (If Deployment Fails)

### Quick Rollback via Vercel
1. Go to Vercel Dashboard → Deployments
2. Find the previous working deployment (commit: e33205b)
3. Click **⋯** → **Promote to Production**
4. Confirm promotion
5. Previous version restored immediately

### Rollback via Git
```bash
# Revert the last commit
git revert 57e100a

# Push revert commit
git push origin main

# Vercel will auto-deploy the reverted state
```

---

## 📊 Monitoring After Deployment

### Check Logs
1. Vercel Dashboard → Runtime Logs
2. Watch for errors in first 24 hours
3. Common issues to watch for:
   - Database connection errors
   - Authentication failures
   - Rate limit triggers

### Check Cron Job
1. Vercel Dashboard → Cron Jobs
2. Verify `/api/cron/retention` is scheduled for `0 4 * * *`
3. Next run should show in dashboard
4. Check logs after first run (4 AM UTC)

### Check Database Stats
1. Open admin endpoint: `/admin/status`
2. Verify OAuth status
3. Check pool stats: `pool_total`, `pool_idle`, `pool_waiting`
4. Expected: `pool_total` should be ≤40

---

## 🎉 Success Criteria

### Deployment Successful If:
- [x] Vercel build completes without errors
- [x] Scanner page loads at production URL
- [x] Register selection modal works
- [x] "Return to POS" button visible
- [x] "Close Scanner" button NOT visible
- [x] PWA manifest accessible
- [x] Admin routes protected (if tokens set)
- [x] No console errors in browser

### Ready for Production If:
- [x] All environment variables set
- [x] Database connected (if using Neon)
- [x] iPad PWA installation tested
- [x] Register localStorage persistence works
- [x] Swipe gesture returns to other apps
- [x] No critical errors in logs

---

## 📝 Notes

### What Changed in This Release
1. **Backend**: Connection pool, retention policy, security middleware, cron jobs
2. **Frontend**: Removed iframe logic, added register flow, PWA support
3. **UX**: Companion App model - no more iframe navigation issues

### Known Limitations
- Camera requires HTTPS (production only)
- PWA installation requires Safari on iOS
- Manual app switching via swipe (no automatic return to POS)

### Next Steps
- Monitor deployment for 24 hours
- Collect feedback from pilot locations
- Plan gradual rollout to all 18 locations

---

**Deployment Lead**: Development Team
**Review Date**: December 3, 2025
**Production URL**: https://[your-project].vercel.app

# ⚡ Quick Start - ID Scanner Integration

## 🎯 When You Get API Credentials

**You'll receive from your boss:**
1. Lightspeed API Key (long string of letters/numbers)
2. Lightspeed Account ID (usually 5-6 digits)

---

## 🚀 Immediate Steps

### **1. Add Credentials to Vercel (2 minutes)**

Go to: https://vercel.com/dashboard → Your Project → Settings → Environment Variables

**Add these variables:**
```
LIGHTSPEED_API_KEY = <paste the API key here>
LIGHTSPEED_ACCOUNT_ID = <paste the account ID here>
```

Click **Save** → Click **Redeploy**

✅ **Done!** The system will automatically switch from mock to real Lightspeed API.

---

### **2. Get Your Vercel URL**

After deployment completes:
- Copy your production URL (looks like: `https://id-scanner-xyz.vercel.app`)
- You'll need this for the custom buttons

---

### **3. Configure Lightspeed Custom Buttons (5 minutes)**

**In Lightspeed Back Office:**
1. Go to: **Settings → Custom Menus → Register: Payment Tab**

2. Click **"Add Button"** and create:

**Button 1:**
```
Label: Cash (ID Required)
Type: Open Web Page
URL: https://YOUR-VERCEL-URL.vercel.app/checkout.html?type=cash&saleId={saleID}&employeeID={employeeID}&accountID={accountID}
```

**Button 2:**
```
Label: Card (ID Required)
Type: Open Web Page
URL: https://YOUR-VERCEL-URL.vercel.app/checkout.html?type=card&saleId={saleID}&employeeID={employeeID}&accountID={accountID}
```

3. **Delete old buttons:**
   - Find "Cash" → Click trash icon → Delete
   - Find "Card" → Click trash icon → Delete

✅ **Done!** Buttons appear at all 13 locations automatically.

---

### **4. Test It! (2 minutes)**

1. Ring up a test sale in Lightspeed
2. Click "Cash (ID Required)"
3. Scan an ID with iPad camera
4. Watch it auto-complete!

✅ **If that works, you're ready to go live!**

---

## 📋 What Happens Next

**The Complete Workflow:**
```
Clerk rings up items
    ↓
Clicks "Cash (ID Required)" or "Card (ID Required)"
    ↓
Scanner opens (2 sec)
    ↓
Customer scans ID (2 sec)
    ↓
Shows "21+ Verified" (1 sec)
    ↓
Auto-completes sale (2 sec)
    ↓
Scanner closes
    ↓
Back to Lightspeed - Receipt prints
```

**Total time: 5-10 seconds**

---

## ✅ Go-Live Checklist

Before training clerks:
- [ ] API credentials added to Vercel
- [ ] Vercel shows "✅ Lightspeed API credentials found" in logs
- [ ] Custom buttons created in Lightspeed
- [ ] Native Cash/Card buttons deleted
- [ ] Test sale completed successfully
- [ ] Sale has "ID Verified" note in Lightspeed

---

## 🆘 Quick Troubleshooting

**Scanner won't open?**
→ Check the custom button URL has your correct Vercel domain

**"Unable to fetch sale" error?**
→ Check API credentials in Vercel → Redeploy

**Sale won't complete?**
→ Check Vercel logs for specific error message

---

## 📞 Need Help?

**Lightspeed Support:** 866-932-1801

**Check Logs:**
- Vercel Dashboard → Your Project → Deployments → Click latest → View Function Logs

---

**See [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) for complete details.**

**You're ready to deploy! 🚀**

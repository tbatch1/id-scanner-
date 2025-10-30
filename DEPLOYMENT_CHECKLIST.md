# 🚀 Deployment Checklist - ID Scanner Integration

## ✅ PRE-DEPLOYMENT (Complete These First)

### **1. Get Lightspeed API Credentials**
- [ ] Get API Key from boss or Lightspeed back office (Settings → API)
- [ ] Get Account ID from Lightspeed URL or Settings → API
- [ ] Save both in a secure location

### **2. Configure Environment Variables**
On your production server (Vercel):

```bash
LIGHTSPEED_API_KEY=<your_actual_api_key>
LIGHTSPEED_ACCOUNT_ID=<your_actual_account_id>
NODE_ENV=production
PORT=4000
LOG_LEVEL=info
VERIFICATION_EXPIRY_MINUTES=15
MINIMUM_AGE=21
```

**How to add on Vercel:**
1. Go to your Vercel project dashboard
2. Settings → Environment Variables
3. Add each variable above
4. Redeploy after adding variables

### **3. Test Payment Type IDs**
Once API credentials are added:
- [ ] Visit: `https://your-vercel-url.vercel.app/api/health`
- [ ] Check server logs for "Payment types loaded" message
- [ ] Verify cash and card IDs are detected

---

## 📱 DEPLOYMENT STEPS

### **Step 1: Configure Custom Buttons in Lightspeed**

**Location:** Settings → Custom Menus → Register: Payment Tab

**Button 1: Cash (ID Required)**
- **Label:** `Cash (ID Required)`
- **Type:** `Open Web Page`
- **URL:**
  ```
  https://your-vercel-url.vercel.app/checkout.html?type=cash&saleId={saleID}&employeeID={employeeID}&accountID={accountID}
  ```

**Button 2: Card (ID Required)**
- **Label:** `Card (ID Required)`
- **Type:** `Open Web Page`
- **URL:**
  ```
  https://your-vercel-url.vercel.app/checkout.html?type=card&saleId={saleID}&employeeID={employeeID}&accountID={accountID}
  ```

### **Step 2: Delete Native Payment Buttons**

Still in: Settings → Custom Menus → Register: Payment Tab

- [ ] Find "Cash" button → Click trash icon → Confirm deletion
- [ ] Find "Card" button → Click trash icon → Confirm deletion
- [ ] Verify custom buttons appear on payment screen
- [ ] Changes apply automatically to all 13 locations (one account)

---

## 🧪 TESTING CHECKLIST

### **Test at Pilot Location:**

**Test 1: Cash Payment**
- [ ] Ring up test sale in Lightspeed
- [ ] Click "Cash (ID Required)" button
- [ ] Scanner opens in new tab/window
- [ ] Scan valid ID (21+)
- [ ] Verify: "21+ Verified" message shows
- [ ] Wait 2 seconds → Sale auto-completes
- [ ] Scanner closes automatically
- [ ] Check Lightspeed: Sale is completed with Cash payment
- [ ] Check Sale Notes: "ID Verified: [name], Age [age]" appears

**Test 2: Card Payment**
- [ ] Repeat above with "Card (ID Required)" button
- [ ] Verify sale completes with Card payment type

**Test 3: Under-21 Rejection**
- [ ] Scan ID of someone under 21 (if available for testing)
- [ ] Verify: "Under 21" message shows
- [ ] Verify: Sale does NOT complete
- [ ] Verify: Can rescan another ID

**Test 4: Multiple Clerks**
- [ ] Have 2-3 clerks test simultaneously
- [ ] Verify: No conflicts or errors
- [ ] All sales complete correctly

---

## 🎓 CLERK TRAINING

### **Quick Training Script:**

> **"We have a new age verification system. Here's what's different:"**
>
> 1. Ring up items as normal
> 2. When ready to pay, tell customer: "I need to scan your ID"
> 3. Click either:
>    - **"Cash (ID Required)"** for cash payments
>    - **"Card (ID Required)"** for credit/debit
> 4. Scanner pops up → Customer holds ID to iPad camera
> 5. **BEEP!** → Shows verification result
> 6. Wait 2 seconds → Sale completes automatically
> 7. Print/email receipt as normal
>
> **Total time: 5-10 seconds extra per sale**

### **Common Questions:**

**Q: What if customer refuses ID scan?**
A: Cannot complete sale without verification. Explain it's required by law.

**Q: What if scanner doesn't work?**
A: Restart scan button. If still fails, call manager.

**Q: Can I use the old Cash/Card buttons?**
A: No - they've been removed. Only use "(ID Required)" buttons.

---

## 📊 POST-DEPLOYMENT MONITORING

### **Week 1: Daily Checks**
- [ ] Check Vercel logs for errors
- [ ] Review sales in Lightspeed - verify all have "ID Verified" notes
- [ ] Ask clerks for feedback
- [ ] Monitor scanner uptime

### **Week 2-4: Weekly Checks**
- [ ] Review compliance (all sales have verification notes)
- [ ] Check for any bypassed sales (missing notes)
- [ ] Gather feedback from all 13 locations
- [ ] Document any issues

---

## 🔧 TROUBLESHOOTING

### **Issue: Scanner won't open**
- Check: Is Vercel URL correct in custom button?
- Check: Is site deployed and accessible?
- Try: Hard refresh (Ctrl+Shift+R)

### **Issue: "Unable to fetch sale" error**
- Check: Are API credentials correct in Vercel?
- Check: Is API key active in Lightspeed?
- Try: Restart Vercel deployment

### **Issue: Sale won't complete**
- Check: Was ID scan successful (check notes)?
- Check: Is verification approved?
- Check: Server logs for specific error

### **Issue: Wrong payment type recorded**
- Check: Did clerk click correct button (Cash vs Card)?
- Verify: URL has `?type=cash` or `?type=card`

---

## 🎯 ROLLOUT SCHEDULE

### **Phase 1: Pilot (Week 1)**
- Location: [Choose busiest location]
- Monitor closely
- Fix any issues immediately

### **Phase 2: Expansion (Week 2)**
- Locations: 3-5 additional stores
- Compare results with pilot
- Refine training materials

### **Phase 3: Full Deployment (Week 3-4)**
- All remaining locations (automatic via one account!)
- Continue monitoring
- Celebrate success! 🎉

---

## 📞 SUPPORT CONTACTS

**Lightspeed Support:**
- Phone: 866-932-1801
- Email: retail.support@lightspeedhq.com

**Your Vercel Dashboard:**
- https://vercel.com/dashboard

**API Documentation:**
- https://developers.lightspeedhq.com/retail/

---

## ✅ GO-LIVE CHECKLIST

**Before going live at each location:**
- [ ] API credentials configured
- [ ] Custom buttons created and tested
- [ ] Native buttons deleted
- [ ] Clerks trained
- [ ] Test sale completed successfully
- [ ] Manager knows troubleshooting steps
- [ ] Support contacts visible

---

## 🎉 SUCCESS CRITERIA

After 30 days:
- [ ] 100% of sales have "ID Verified" notes
- [ ] Zero compliance violations
- [ ] Average scan time < 10 seconds
- [ ] Clerk satisfaction rating > 4/5
- [ ] Zero bypassed sales

---

**Questions? Issues? Check Vercel logs first, then contact Lightspeed Support.**

**Good luck! 🚀**

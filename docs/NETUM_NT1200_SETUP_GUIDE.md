# Netum NT-1200 Scanner Setup Guide for ID Scanning Project

## Required Configuration Barcodes to Scan

Follow these steps **in order** to configure your Netum NT-1200 scanner for the ID scanning system.

---

## Step 1: Factory Reset (Optional but Recommended)

**Purpose:** Start with clean settings

**Barcode to scan:** `Factory Reset` or `Restore Defaults`

**Where to find:** Look in your manual for "Factory Reset" or "Default Settings" section

---

## Step 2: Enable Bluetooth HID Mode ✅

**Purpose:** Allow scanner to act as Bluetooth keyboard

**Barcode to scan:** `Bluetooth Transport` or `Basic Mode (HID)`

**What it does:**
- Enables Bluetooth HID (Human Interface Device) mode
- Scanner will type like a keyboard
- Works with iPad/iPhone/PC

**Status:** ✅ You already scanned this

---

## Step 3: Set Keyboard Language ✅

**Purpose:** Ensure special characters (]L prefix) are typed correctly

**Barcode to scan:** `American EN Keyboard` or `US Keyboard`

**What it does:**
- Maps keys to US keyboard layout
- Critical for PDF417 barcodes with `]L` AIM ID prefix
- Wrong keyboard layout = wrong characters

**Status:** ✅ You already scanned this

---

## Step 4: Enable PDF417 Barcode Format ⚠️ CRITICAL

**Purpose:** Allow scanning of driver's license barcodes

**Barcode to scan:** `Enable PDF417` or barcode ID `1000170`

**What it does:**
- Activates PDF417 2D barcode reading
- Driver's licenses use PDF417 format (AAMVA standard)
- Must be enabled or scanner won't read IDs

**How to verify:** Try scanning back of driver's license - should beep and read

---

## Step 5: Set Bluetooth Keyboard Upload Speed ⚠️ MOST CRITICAL

**Purpose:** Prevent browser overwhelm from rapid keystrokes

### Option A: Low Speed (RECOMMENDED)
**Barcode command:** `AT+HIDDLY=25`

**What it does:**
- Adds 25ms delay between each character
- Total scan time: ~1.5 seconds
- Prevents iPad browser from freezing
- 100% reliable, no data loss

**Why critical:** Default speed (AT+HIDDLY=10) sends 50-100 keystrokes in <200ms which crashes the browser

### Option B: Medium Speed (Alternative)
**Barcode command:** `AT+HIDDLY=30`

**Use if:** You want slightly slower speed for extra safety

### How to Create Configuration Barcode:

Since the manual may not include AT+HIDDLY barcodes, you can:

1. **Use online barcode generator:**
   - Go to: https://www.barcode-generator.org/
   - Select format: Code 128 or Code 39
   - Enter text: `AT+HIDDLY=25`
   - Generate and print barcode
   - Scan with your Netum NT-1200

2. **Or create QR code:**
   - Go to: https://www.qr-code-generator.com/
   - Enter text: `AT+HIDDLY=25`
   - Download QR code
   - Scan with your Netum NT-1200

---

## Step 6: Set Terminator (Optional)

**Purpose:** Control what character is sent at end of scan

### Option A: No Terminator (RECOMMENDED)
**Barcode to scan:** `Terminator: None`

**Why:** Our debounced listener auto-detects scan completion (70ms timeout). No Enter key needed.

### Option B: Carriage Return (Alternative)
**Barcode to scan:** `Terminator: CR` or `Suffix: Enter`

**Use if:** You want traditional Enter key behavior

**Status:** ✅ You may have already scanned this

---

## Step 7: Disable Prefix (Optional)

**Purpose:** Prevent extra characters before scan data

**Barcode to scan:** `Prefix: None` or `Disable Prefix`

**What it does:**
- Ensures no characters added before `]L` prefix
- Keeps barcode data clean

---

## Step 8: Pair with iPad

**Steps:**

1. Turn on scanner (power button)
2. Scan "Bluetooth Transport" barcode (if not already done)
3. On iPad: Settings > Bluetooth
4. Look for "Netum Bluetooth" or "NT-1200"
5. Tap to pair
6. Enter PIN if prompted (usually `0000` or `1234`)

**Verify connection:**
- Scanner LED should be **solid blue** (not flashing)
- Scanner beeps once when connected

---

## Step 9: Test Configuration

### Test 1: Simple Text Test
1. Open Notes app on iPad
2. Create new note
3. Scan any barcode (product label, test barcode)
4. **Expected:** Text appears smoothly over 1-2 seconds
5. **Wrong:** Nothing appears OR text appears instantly (too fast)

### Test 2: Scanner Test Page
1. Open on iPad: https://id-scanner-project.vercel.app/scanner-test.html
2. Scan your driver's license (back side with barcode)
3. **Expected results:**
   ```
   [14:23:50.100] 🔑 Keystroke buffered (total: 1 chars)
   [14:23:50.125] 🔑 Keystroke buffered (total: 2 chars)
   [14:23:50.150] 🔑 Keystroke buffered (total: 3 chars)
   ... (continues with ~25ms intervals)
   [14:23:51.570] ✅ Scan complete (debounce timeout reached)
   [14:23:51.570] Buffer length: 458
   [14:23:51.570] ✓ Valid PDF417 barcode detected (starts with ]L)
   ```

### Test 3: Full Payment Gateway Test
1. Open: https://id-scanner-project.vercel.app/payment-gateway.html?reference_id=test123
2. Scan your driver's license
3. **Expected:** Green success screen with your name and age
4. **Check:** Dashboard shows scan within 10 seconds

---

## Configuration Summary Checklist

Before using scanner in production:

- [ ] **Factory Reset** (optional but recommended)
- [ ] **Bluetooth Transport/HID Mode** enabled ✅
- [ ] **US/American EN Keyboard** layout set ✅
- [ ] **PDF417 barcode format** enabled ⚠️ CRITICAL
- [ ] **AT+HIDDLY=25** (Low Speed) configured ⚠️ MOST CRITICAL
- [ ] **Terminator: None** or **Terminator: CR** set
- [ ] **Prefix: None** or disabled
- [ ] **Paired to iPad** via Bluetooth
- [ ] **Solid blue LED** (not flashing)
- [ ] **Tested in Notes app** - smooth typing
- [ ] **Tested on scanner-test.html** - 25ms intervals
- [ ] **Tested on payment gateway** - successful scan

---

## Troubleshooting

### Scanner LED Flashing Blue
**Issue:** Not connected to iPad
**Fix:** Go to iPad Settings > Bluetooth > Connect to "Netum Bluetooth"

### Scanner Beeps But No Text Appears
**Issue:** Not in HID keyboard mode
**Fix:** Scan "Bluetooth Transport" barcode again

### Text Appears But Wrong Characters
**Issue:** Wrong keyboard layout
**Fix:** Scan "American EN Keyboard" barcode

### Scanner Won't Read Driver's License
**Issue:** PDF417 format disabled
**Fix:** Scan "Enable PDF417" barcode

### Browser Freezes or Partial Data
**Issue:** Scanner speed too fast (default setting)
**Fix:** Scan `AT+HIDDLY=25` barcode (CRITICAL)

### Scan Works But Shows "Unknown Customer"
**Issue:** Barcode not AAMVA format or damaged
**Fix:** Try different angle, check if scanning back of ID (where barcode is)

---

## Where to Find Configuration Barcodes

### Option 1: Official Manual
- Download from: https://www.netum.net/pages/barcode-scanner-user-manuals
- Look for NT-1200 or NT-1228BL (similar model)
- Check sections:
  - "Bluetooth Settings"
  - "Keyboard Settings"
  - "Symbology Settings" (for PDF417)
  - "Bluetooth Keyboard Upload Speed" (for AT+HIDDLY)

### Option 2: Generate Your Own
For AT+HIDDLY commands not in manual:
- Use https://www.barcode-generator.org/
- Select Code 128 format
- Enter: `AT+HIDDLY=25`
- Print and scan

### Option 3: Contact Netum Support
- Website: https://www.netum.net/
- Email: Usually support@netum.net
- Request: Full configuration manual with AT+HIDDLY barcodes

---

## Key AT Commands Reference

| Command | Purpose | Value |
|---------|---------|-------|
| `AT+HIDDLY=10` | High speed | ~10ms per character (TOO FAST) |
| `AT+HIDDLY=25` | Low speed | ~25ms per character (RECOMMENDED) |
| `AT+HIDDLY=30` | Lower speed | ~30ms per character (Alternative) |
| `AT+HIDDLY=45` | Very low speed | ~45ms per character (Very safe) |

---

## Sources & References

- [NETUM NT-1200 Barcode Scanner Instruction Manual](https://manuals.plus/netum/nt-1200-barcode-scanner-manual)
- [Netum NT-1228BL Manual - Bluetooth Keyboard Upload Speed](https://www.manualslib.com/manual/1800666/Netum-Nt-1228bl.html?page=7)
- [Barcode Scanner User Manuals – NETUM](https://www.netum.net/pages/barcode-scanner-user-manuals)
- [NETUM C Series Manual - C750 Barcode Scanner Guide](https://manualzz.com/doc/61703520/netum-c-series--c750-manual)
- [NT-1228BC Barcode Scanner General Keyboard Settings](https://www.netum.net/a/docs/nt-series-scanner-manuals/nt-1228bc-barcode-scanner-general-keyboard-settings)

---

## Critical Takeaways

### 3 Most Important Settings:

1. **✅ Bluetooth HID Mode** - Already done
2. **⚠️ Enable PDF417** - Must do or can't read IDs
3. **⚠️ AT+HIDDLY=25** - Must do or browser crashes

Without these 3 settings, the scanner will NOT work with your ID scanning system.

---

**Next Step:** Scan the required configuration barcodes and test with the scanner-test.html page!

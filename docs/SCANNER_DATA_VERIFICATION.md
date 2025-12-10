# Scanner Data Verification Guide - Netum NT-1200

## What Data We Extract from Driver's Licenses

Our system parses **AAMVA-compliant PDF417 barcodes** on US driver's licenses. Here's exactly what data fields we extract and use:

### AAMVA Data Fields We Parse

| Field Code | Field Name | Purpose | Example | Required |
|------------|------------|---------|---------|----------|
| **DAC** | First Name | Customer identification | "JOHN" | ✅ Yes |
| **DCS** | Last Name | Customer identification | "SMITH" | ✅ Yes |
| **DAA** | Full Name | Fallback if DAC/DCS missing | "SMITH,JOHN" | Optional |
| **DBB** | Date of Birth | Age verification | "19900115" (Jan 15, 1990) | ✅ Yes |
| **DAQ** | Document Number | DL number for records | "D12345678" | ✅ Yes |
| **DBA** | Expiry Date | Check if ID is valid | "20301231" | Optional |
| **DBC** | Sex | Demographic data | "1" (M) or "2" (F) | Optional |
| **DCG** | Issuing Country | Origin verification | "USA" | Optional |
| **DAK** | Postal Code | Location data | "78701" | Optional |

### Critical Data Flow

```
Scanner reads PDF417 barcode
↓
Sends keystrokes with ]L prefix
↓
Backend receives: "]L0ANSI 636015080002DL00410278ZT03290015DLDAQ..."
↓
parseAAMVA() extracts fields:
  - firstName: "JOHN"
  - lastName: "SMITH"
  - dob: Date object (1990-01-15)
  - age: 34
  - documentNumber: "D12345678"
↓
Age verification: age >= 21? ✅ Approved / ❌ Rejected
↓
Save to database + Update in-memory store
↓
Display result to cashier
```

## Scanner Configuration Requirements

### 1. PDF417 Barcode Support
**Status:** ✅ NT-1200 supports PDF417 by default

**What it is:** PDF417 is the 2D barcode format printed on the back of US driver's licenses. Contains all AAMVA data fields.

**Visual check:** Back of driver's license has rectangular barcode (looks like dense horizontal lines)

### 2. Bluetooth HID Keyboard Mode
**Status:** ✅ Already configured (you scanned "Bluetooth Transport")

**What it does:** Scanner types barcode data as keyboard input

**Verify:** Scanner LED is solid blue (not flashing)

### 3. American EN Keyboard Layout
**Status:** ✅ Already configured

**What it does:** Ensures special characters like `]` `L` are typed correctly

**Why critical:** PDF417 barcodes start with `]L` prefix. Wrong keyboard = wrong prefix = parsing fails

### 4. LOW SPEED Transmit Setting ⚠️
**Status:** ⚠️ **MUST CONFIGURE THIS**

**Configuration barcode:** `AT+HIDDLY=25`

**Where to find:** Netum manual Page 12 - "Bluetooth Keyboard Upload Speed"

**Why critical:**
- Default speed: 50-100 keystrokes in <200ms → Browser overwhelms
- Low speed: 25ms per character → Browser handles smoothly
- Total scan time: ~1.5 seconds (perfect for checkout)

### 5. Terminator Setting (Optional)
**Recommended:** Scan "Terminator: None"

**Why:** Our debounced listener auto-detects scan completion. Enter key not needed.

## How to Verify Scanner is Working Correctly

### Test 1: Physical Indicators
✅ Scanner LED is **solid blue** (not flashing)
✅ Scanner beeps when trigger is pulled
✅ iPad Bluetooth settings show "Netum Bluetooth" as Connected

### Test 2: Scanner Test Page
**URL:** https://id-scanner-project.vercel.app/scanner-test.html

**What to check:**
```
1. Open URL on iPad
2. Scan your driver's license
3. Watch the live log

Expected output (CORRECT configuration):
[02:23:50.100] 🔑 Keystroke buffered (total: 1 chars)
[02:23:50.125] 🔑 Keystroke buffered (total: 2 chars)  ← 25ms intervals
[02:23:50.150] 🔑 Keystroke buffered (total: 3 chars)
... (continues smoothly)
[02:23:51.570] ✅ Scan complete (debounce timeout reached)
[02:23:51.570] Buffer length: 458
[02:23:51.570] ✓ Valid PDF417 barcode detected (starts with ]L)

WRONG configuration (too fast):
[02:23:50.100] 🔑 Keystroke buffered (total: 1 chars)
[02:23:50.102] 🔑 Keystroke buffered (total: 2 chars)  ← 2ms intervals!
[02:23:50.104] 🔑 Keystroke buffered (total: 3 chars)
... (rapid, overwhelming)
[Browser may freeze or miss characters]
```

### Test 3: Payment Gateway End-to-End Test
**URL:** https://id-scanner-project.vercel.app/payment-gateway.html?reference_id=test123

**What to check:**
```
1. Page loads showing "Waiting for ID Scan"
2. Scan your driver's license
3. Expected result (if 21+):
   ✅ Green screen: "Approved - Age 34"
   Shows customer name

4. Check admin dashboard:
   https://id-scanner-project.vercel.app/admin/scans.html
   Should see scan appear within 10 seconds
```

## Common Issues & Solutions

### Issue: Scanner beeps but nothing happens
**Cause:** Page doesn't have focus
**Fix:** Tap/click the page before scanning

### Issue: Partial data only / Missing characters
**Cause:** Scanner transmitting too fast
**Fix:** Scan `AT+HIDDLY=25` barcode (Low Speed setting)

### Issue: Scan shows "Unknown Customer" or fails to parse
**Possible causes:**
1. Not a PDF417 barcode (scanned wrong side of ID)
2. Damaged/unreadable barcode on ID
3. Scanner not configured for American EN keyboard

**Fix:**
- Scan back of driver's license (where barcode is)
- Try different angle/distance
- Verify keyboard layout configuration

### Issue: Age shows as null or undefined
**Cause:** Date of birth (DBB field) not parsed correctly
**Check:** Scanner test page shows raw data - verify DBB field exists

### Issue: Browser freezes during scan
**Cause:** Scanner speed too fast (default setting)
**Fix:** MUST scan `AT+HIDDLY=25` barcode

## Data Verification Checklist

Before going live with scanner:

- [ ] Scanner LED is solid blue (connected)
- [ ] Scanned `AT+HIDDLY=25` (Low Speed)
- [ ] Scanned `American EN Keyboard`
- [ ] Scanned `Bluetooth Transport`
- [ ] Tested on scanner-test.html - sees all keystrokes with 25ms intervals
- [ ] Tested on payment-gateway.html - scan approves 21+ customer
- [ ] Verified scan appears in admin dashboard within 10 seconds
- [ ] Confirmed data fields populated:
  - [ ] First Name
  - [ ] Last Name
  - [ ] Date of Birth / Age
  - [ ] Document Number
  - [ ] Issuing Country

## Technical Details: AAMVA Format

### PDF417 Barcode Structure
```
]L0          ← AIM ID + Length descriptor
ANSI 636015  ← ANSI header + IIN (Issuer Identification Number)
DL           ← Document type (Driver License)
DAQ...       ← Data elements (3-char codes)
DAC...
DCS...
DBB...
(etc.)
```

### Our Parsing Strategy
1. **Prefix detection:** Check for `]L` (PDF417 AIM ID)
2. **Field extraction:** Regex patterns to find `DAC`, `DCS`, `DBB`, etc.
3. **Date parsing:** Handle YYYYMMDD and MMDDYYYY formats
4. **Age calculation:** Current date minus DOB
5. **Validation:** Age >= 21 for approval

### Alternative Field Codes
Some states use different codes:
- **DCT** instead of **DAC** (First Name)
- **DCP** instead of **DCS** (Last Name)

Our parser checks both variants automatically.

## References

- **AAMVA Standard:** Driver's License/ID Card Design Standard (DL/ID-2020)
- **PDF417 Specification:** ISO/IEC 15438
- **Netum NT-1200 Manual:** https://www.netum.net/pages/barcode-scanner-user-manuals
- **Our Scanner Test Page:** https://id-scanner-project.vercel.app/scanner-test.html

## Sources
- [NETUM NT-1200 Barcode Scanner Instruction Manual](https://manuals.plus/netum/nt-1200-barcode-scanner-manual)
- [Netum Barcode Scanner User Manuals](https://www.netum.net/pages/barcode-scanner-user-manuals)
- [North America Driver License and Identification - AAMVA Standard](https://www.dynamsoft.com/code-parser/docs/core/code-types/aamva-dl-id.html)
- [Reading and Writing AAMVA Barcodes on Driver's Licenses | LEADTOOLS Blog](https://www.leadtools.com/blog/barcode/reading-writing-aamva-barcodes-drivers-licenses/)

---

**Critical Next Step:** Scan the `AT+HIDDLY=25` barcode from Page 12 of your Netum manual to enable Low Speed transmission!

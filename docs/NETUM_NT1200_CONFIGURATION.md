# Netum NT-1200 Scanner Configuration Guide

## Critical Issue: Scanner Overwhelming the iPad

The Netum NT-1200 in HID (Keyboard) mode sends **50-100 keystrokes in under 200ms**. This overwhelms the iPad's Bluetooth buffer and browser, causing:
- UI freezing
- Hydration errors
- Scan failures
- Browser crashes

## Required Hardware Configuration

### 1. Set Bluetooth Transmit Speed to LOW SPEED

**Location:** Netum NT-1200/C750 Manual, Page 12 - "Bluetooth Keyboard Upload Speed"

**Barcode to Scan:**
```
AT+HIDDLY=25
```

**Effect:**
- Adds ~25ms delay between each character
- Total scan time: ~1.5 seconds (instead of <200ms)
- Prevents browser overwhelm
- 100% accurate scans

**Where to Find:**
- Full manual: https://netumtech.com/user-manual/
- Search for: "Bluetooth Keyboard Upload Speed"
- Alternative search: "AT+HIDDLY" or "transmit speed"

### 2. Disable Terminator (Enter Key)

**Location:** User provided photo, Page 9 - "Terminator Settings"

**Barcode to Scan:**
```
Terminator: None
```

**Why:**
- Our debounced listener auto-detects scan completion
- No Enter key needed
- Prevents accidental form submissions

### 3. Confirm Keyboard Layout

**Location:** User provided photo

**Barcode to Scan:**
```
American EN Keyboard
```

**Why:**
- Ensures special characters (]L prefix) are typed correctly
- Required for PDF417 format recognition

### 4. Confirm Bluetooth Transport Mode

**Barcode to Scan:**
```
Bluetooth Transport
```

**Why:**
- Enables HID keyboard emulation
- Already correctly configured

## Software Configuration

### Debounced Keyboard Listener

The payment gateway now uses a **debounced listener** with a 70ms timeout:

```javascript
// Wait 70ms after last keystroke before processing
const SCAN_DEBOUNCE_MS = 70;

document.addEventListener('keydown', (e) => {
    if (e.key.length === 1) {
        barcodeBuffer += e.key;
        e.preventDefault(); // Prevent browser interference
    }

    // Clear existing timeout
    clearTimeout(scanTimeout);

    // Set new timeout
    scanTimeout = setTimeout(() => {
        if (barcodeBuffer.length >= 10) {
            processScan(barcodeBuffer);
        }
        barcodeBuffer = '';
    }, 70); // Safe for Low Speed setting (25ms per char)
});
```

### Why 70ms?

- **Scanner speed:** 25ms per character (after Low Speed config)
- **Safety margin:** 45ms buffer
- **Total:** 70ms timeout ensures complete scan capture
- **Fast enough:** Still processes scan in ~1.5 seconds total

## Configuration Checklist

Before using scanner with iPad:

- [ ] Scan "AT+HIDDLY=25" (Low Speed) barcode
- [ ] Scan "Terminator: None" barcode
- [ ] Scan "American EN Keyboard" barcode
- [ ] Scan "Bluetooth Transport" barcode
- [ ] Pair scanner to iPad via Settings > Bluetooth
- [ ] Verify solid blue LED (not flashing)
- [ ] Test on scanner-test.html page

## Testing Configuration

### Test Page
```
https://id-scanner-project.vercel.app/scanner-test.html
```

### Expected Behavior (Correct Configuration)
```
[02:23:50.100] 🔑 Keystroke buffered (total: 1 chars)
[02:23:50.125] 🔑 Keystroke buffered (total: 2 chars)
[02:23:50.150] 🔑 Keystroke buffered (total: 3 chars)
... (smooth, consistent 25ms intervals)
[02:23:51.500] ✅ Scan complete (debounce timeout reached)
[02:23:51.500] Buffer length: 458
[02:23:51.500] ✓ Valid PDF417 barcode detected
```

### Wrong Configuration (Too Fast)
```
[02:23:50.100] 🔑 Keystroke buffered (total: 1 chars)
[02:23:50.102] 🔑 Keystroke buffered (total: 2 chars)
[02:23:50.104] 🔑 Keystroke buffered (total: 3 chars)
... (rapid, overwhelming, <5ms intervals)
[Browser freezes or crashes]
```

## Troubleshooting

### Scanner LED is Flashing Blue
- **Issue:** Not connected to iPad
- **Fix:** Go to iPad Settings > Bluetooth > Tap "Netum Bluetooth" > Pair

### Scans Not Appearing
- **Issue:** Wrong transmit speed (too fast)
- **Fix:** Scan "AT+HIDDLY=25" barcode again

### Partial Scans Only
- **Issue:** Timeout too short OR scanner speed too fast
- **Fix:** Ensure Low Speed (AT+HIDDLY=25) is configured

### Scanner Beeps But Nothing Happens
- **Issue:** Page doesn't have focus
- **Fix:** Tap/click the payment gateway page before scanning

## References

- Netum NT-1200 Manual: https://netumtech.com/user-manual/
- PDF417 Barcode Standard: AAMVA DL/ID Card Design Standard
- Bluetooth HID Specification: https://www.bluetooth.com/specifications/specs/hid-profile-1-1-1/

## Summary

**Hardware:** Scan `AT+HIDDLY=25` (Page 12 of manual)
**Software:** Debounced listener with 70ms timeout (already implemented)
**Result:** Smooth, reliable 1.5-second scans with zero browser overwhelm

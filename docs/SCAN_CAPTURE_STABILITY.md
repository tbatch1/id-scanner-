# Scan Capture Stability (iPad + Lightspeed iframe)

## Why it “only works after pressing Debug/Test Ping”
On iPad (WKWebView) inside an embedded iframe, Bluetooth HID scanner keystrokes often **do not route into the iframe until the user performs a gesture inside the iframe** (tap/click).

When someone taps **DBG** (or any other control), that gesture “unblocks” key routing, so the scan suddenly works — which makes it look like Debug is required.

This is an iOS platform restriction; there is no reliable, fully programmatic bypass.

## Our stable approach
We keep a hidden, focusable input (`#ghostInput`) and arm scanning from a **trusted user gesture**:
- Default behavior on iPad/embedded verify flow: **tap-to-arm** (Scan button).
- Optional testing behavior: `?autoStart=1` (auto-arms scanning on load, reliable on non-iOS).

Relevant file: `frontend/payment-gateway-stable.html`

## Operating modes (query params)
- Default (recommended for iPad POS): no extra params; tap Scan to arm.
- Auto-start for testing: `?autoStart=1`
- Force manual mode: `?tapToScan=1`
- Debug UI: `?debug=1` (or long-press the logo ~0.9s to toggle)

## What “working” looks like
After arming, the scan will:
1) Capture the barcode payload from the HID scanner into `ghostInput`.
2) Wait until required fields are present (verify-only waits for enough AAMVA data to compute age).
3) POST to `/api/sales/:saleId/verify-bluetooth`.

## If scanning ever “regresses” again
1) Confirm the page is the stable one:
   - `https://id-scanner-project.vercel.app/payment-gateway-stable.html`
2) On iPad: tap **Scan** once inside the iframe (this is required by iOS in many cases).
3) Enable debug (`?debug=1`) and verify:
   - Focus shows `ghostInput`
   - `GhostLen` increases when scanning


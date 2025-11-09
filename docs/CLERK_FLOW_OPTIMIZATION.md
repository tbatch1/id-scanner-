# Clerk Checkout Flow Optimization

Objective: keep the ID verification step under 10 seconds end-to-end without sacrificing compliance accuracy.

## Pre-Shift Device Setup
- Kiosk auto-launches checkout page in fullscreen kiosk mode (Edge --kiosk).
- Camera auto-focus validated; ambient lighting maintained.
- Local browser cache cleared nightly to avoid stale assets.

## In-Flow Enhancements
1. **Sale Context Prefill**
   - Lightspeed custom button pre-populates `saleId`, `clerkId`, and `type` (cash/card) in the URL.
   - API immediately fetches sale summary so clerk can confirm line items while scanning.
2. **Immediate Scanner Activation**
   - `initScanner()` triggered on page load; no extra clicks to start camera.
   - Audio + haptic feedback (beep + flash) to confirm scan success.
3. **Fast Fail Feedback**
   - Toast + red banner within 500 ms if scan fails, with actionable messaging (move ID closer, use manual entry).
   - Banned hits explicitly instruct clerk to stop sale and call manager.
4. **Auto-complete Logic**
   - Verified 21+ IDs auto-trigger `/complete` after 2 seconds unless clerk cancels, reducing clicks.
   - Manual override button only enabled when verification exists to avoid dead ends.
5. **Keyboard Shortcuts (optional)**
   - Map `Space` to restart scan, `Ctrl+M` to open manual override, reducing mouse movement.

## Throughput Considerations
- Target scan recognition within 2 seconds using Dynamsoft MRZ/PDF417 presets already tuned.
- If camera feed drops < 30 fps, prompt clerk to clean lens or refresh kiosk.
- Ensure backend API responses stay under 200 ms by hosting near Lightspeed region and enabling keep-alive connections.

## Training Notes
- Run mock transactions with new clerks until they can complete a scan < 8 seconds consistently.
- Reinforce manual SOP when scanner fails twice to keep line moving while retaining audit trail.

## Monitoring
- Log verification duration (timestamp difference) to identify slowdowns.
- Alert if more than 3 manual entries occur in 10 minutes (possible hardware issue).

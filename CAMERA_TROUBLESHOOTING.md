# Camera & Permissions Troubleshooting Guide

## Overview
This document explains the camera permission flow, diagnostic features, and fallback mechanisms in the ID Scanner checkout application.

---

## Camera Permission Flow

### Desktop Browsers (Chrome, Firefox, Edge)
1. **Initial Load**: Browser prompts "Allow camera access?" when page loads
2. **User Action Required**: User must click "Allow"
3. **Denied State**: If denied, the "Use Native Camera" fallback button appears
4. **Re-enable**: User must go to browser settings → Site Settings → Camera → Allow

### iOS Safari
1. **Initial Load**: Safari prompts "Allow [site] to access the camera?"
2. **User Action Required**: User must tap "Allow"
3. **Denied State**: If denied once, Safari remembers the choice
4. **Re-enable Steps**:
   - Settings app → Safari → Camera → Ask or Allow
   - OR: Tap the "AA" icon in the address bar → Website Settings → Camera → Allow

### Android Chrome
1. **Initial Load**: Chrome prompts "Allow [site] to use your camera?"
2. **User Action Required**: User must tap "Allow"
3. **Denied State**: If blocked, shows "Camera blocked" icon in address bar
4. **Re-enable**: Tap the blocked icon → Permissions → Camera → Allow

---

## Diagnostic Panel Features

### Scanner Status Panel
Located in the sidebar beneath camera controls:
- **Real-time Status**: Shows current scanner state (e.g., "Enumerating cameras", "Camera stream started")
- **Rolling Log**: Displays last 12 diagnostic events with timestamps
- **Color-coded Messages**:
  - **Blue** (info): Normal operations (camera started, photo captured)
  - **Yellow** (warn): Warnings (no cameras found, decode errors)
  - **Red** (error): Errors (permission denied, unable to access camera)
  - **Gray** (debug): Debug info (zoom capabilities, track settings)

### Log Endpoint
All frontend diagnostic events are sent to `POST /api/logs` for server-side tracking.

**Log Entry Format**:
```json
{
  "timestamp": "2025-10-24T01:25:16.917Z",
  "level": "info|warn|error|debug",
  "message": "Human-readable message",
  "meta": {
    "saleId": "SALE-1001",
    "clerkId": "demo-clerk",
    "activeDeviceId": "camera-device-id",
    "...": "additional context"
  }
}
```

---

## Fallback Mechanisms

### Native Camera Fallback
When WebRTC cameras are unavailable, the app provides a native camera fallback:

**Trigger Conditions**:
- No cameras detected via `enumerateDevices()`
- Camera permission permanently denied
- `getUserMedia()` fails with any error
- Media Devices API not supported

**Fallback UI**:
- Button labeled "Use Native Camera" appears in camera controls
- Clicking opens native device camera/photo picker
- Uses `<input type="file" accept="image/*" capture="environment">`

**Behavior by Platform**:
- **iOS Safari**: Opens native camera app
- **Android Chrome**: Shows "Camera" or "Photos" chooser
- **Desktop**: Opens file picker (may include webcam capture on some systems)

### Manual Capture with Preview
For difficult-to-scan IDs or poor autofocus:

1. **Shutter Button**: Large circular button at bottom of video (mobile-friendly)
2. **Capture Photo Button**: Traditional button in sidebar controls
3. **Preview Screen**: Shows captured image with options:
   - **Retake**: Discard and return to live view
   - **Use Photo**: Decode the captured image
4. **Feedback**: Status message shows "Processing..." or error details

---

## iOS-Specific Features

### Pinch-to-Zoom Gestures
- **Two-finger pinch**: Adjust camera zoom level
- **Supported**: On devices with zoom capability (iPhone 11+, iPad Pro)
- **Diagnostic**: Check log for "Zoom enabled" message with min/max values
- **Not Supported**: Older devices show "Zoom capability not reported"

### Touch-friendly Controls
- **Shutter button**: 72px diameter, easy to tap with thumb
- **Control spacing**: 16px gaps for fat-finger tolerance
- **Viewport**: `user-scalable=yes, maximum-scale=5.0` for accessibility

### Webkit-Specific Attributes
- Video element includes `webkit-playsinline` for iOS compatibility
- `playsinline` prevents fullscreen takeover
- `muted autoplay` ensures video starts without user interaction

---

## Common Issues & Solutions

### Issue: "No camera found" on mobile
**Causes**:
- Permission denied in browser settings
- Camera in use by another app
- iOS Low Power Mode (sometimes blocks camera)

**Solutions**:
1. Tap "Refresh cameras" button
2. Check Settings → Safari → Camera
3. Close other apps using camera
4. Use "Use Native Camera" fallback

### Issue: Camera shows but won't focus
**Causes**:
- Auto-focus not engaging
- Barcode too close or too far
- Poor lighting conditions

**Solutions**:
1. Move ID 4-6 inches from camera
2. Use "Capture Photo" for manual capture
3. Pinch-to-zoom to adjust framing
4. Ensure good lighting (avoid glare)

### Issue: Scan works but says "Could not read"
**Causes**:
- Barcode damaged or worn
- Incorrect barcode format (not PDF417)
- Image too blurry or dark

**Solutions**:
1. Clean ID surface
2. Use manual capture with preview
3. Try "Retake" with better positioning
4. Check diagnostic log for decode errors

### Issue: Fallback button doesn't upload photo
**Causes**:
- File too large (>10MB)
- Invalid image format
- JavaScript error during FileReader

**Solutions**:
1. Check browser console for errors
2. Try different photo (smaller size)
3. Diagnostic log shows "Unable to load native photo" on error

---

## Testing Checklist

### Desktop Testing
- [ ] Camera prompt appears on first load
- [ ] Camera dropdown populated with available cameras
- [ ] Manual snapshot works
- [ ] Pinch-zoom (trackpad) adjusts zoom
- [ ] Fallback button appears when camera blocked

### iOS Safari Testing
- [ ] Camera permission prompt shows on first load
- [ ] Video plays inline (not fullscreen)
- [ ] Shutter button accessible with thumb
- [ ] Pinch-to-zoom gesture works smoothly
- [ ] Native camera fallback opens iOS Camera app
- [ ] Preview screen shows captured photo
- [ ] "Retake" returns to live view
- [ ] "Use Photo" decodes barcode

### Android Chrome Testing
- [ ] Camera permission prompt appears
- [ ] Rear camera selected by default
- [ ] Shutter button easily tappable
- [ ] Fallback opens native camera chooser
- [ ] Diagnostics panel scrolls correctly

---

## Diagnostic Log Interpretation

### Successful Scan Flow
```
10:30:15 | Scanner initialising
10:30:15 | Enumerating cameras
10:30:16 | Camera list loaded (count: 2)
10:30:16 | Camera stream started
10:30:16 | Zoom enabled (min: 1, max: 4, current: 1.6)
10:30:22 | Scan decoded (age: 28, name: John Doe)
```

### Permission Denied Flow
```
10:30:15 | Scanner initialising
10:30:15 | Enumerating cameras
10:30:15 | No cameras enumerated. Attempting prompt.
10:30:16 | Camera permission denied (NotAllowedError)
[Fallback button appears]
10:30:25 | Photo imported from native camera
10:30:26 | Decoded barcode from still frame
```

### No Camera Available Flow
```
10:30:15 | Scanner initialising
10:30:15 | Enumerating cameras
10:30:15 | Media devices API not available
[Fallback button appears]
```

---

## Tunnel Testing with Password

When testing via Cloudflare/ngrok tunnel with password `73.6.144.185`:

1. **First Access**: Browser shows authentication prompt
2. **Enter Password**: `73.6.144.185`
3. **Camera Prompt**: After auth, camera permission prompt appears
4. **HTTPS Required**: Tunnels use HTTPS, required for `getUserMedia()`
5. **Mobile Testing**: Share tunnel URL to phone, enter password, allow camera

---

## API Endpoints

### Log Endpoint
```http
POST /api/logs
Content-Type: application/json

{
  "timestamp": "ISO8601 timestamp",
  "level": "info|warn|error|debug",
  "message": "Event description",
  "meta": {
    "saleId": "SALE-1001",
    "clerkId": "demo-clerk",
    "activeDeviceId": "device-id",
    "custom": "Additional context"
  }
}

Response: 202 Accepted
{
  "received": true
}
```

### Other Endpoints
- `GET /api/health` - Server health check
- `GET /api/sales` - List all sales
- `GET /api/sales/:saleId` - Get sale details
- `POST /api/sales/:saleId/verify` - Submit age verification
- `POST /api/sales/:saleId/complete` - Complete verified sale

---

## Browser Compatibility

| Feature | Chrome | Safari | Firefox | Edge |
|---------|--------|--------|---------|------|
| WebRTC Camera | ✅ | ✅ | ✅ | ✅ |
| Pinch Zoom | ✅ | ✅ | ✅ | ✅ |
| Native Fallback | ✅ | ✅ | ✅ | ✅ |
| Manual Capture | ✅ | ✅ | ✅ | ✅ |
| Diagnostics | ✅ | ✅ | ✅ | ✅ |

**Minimum Versions**:
- Chrome 63+
- Safari 11+
- Firefox 60+
- Edge 79+

---

## Contact & Support

For issues not covered in this guide:
1. Check browser console for JavaScript errors
2. Review diagnostic log in Scanner Status panel
3. Test with fallback camera if WebRTC fails
4. Verify tunnel password is correct (`73.6.144.185`)
5. Ensure HTTPS is used (required for camera access)

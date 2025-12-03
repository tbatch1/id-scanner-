# Research Findings & Implementation Plan: Lightspeed Iframe Navigation

## Research Summary
- **Target System**: Lightspeed Retail (R-Series), indicated by `registerId`, `saleId` params and `merchantos.com` references.
- **"Break Out" Mechanism**: There is no official "breakout" API. The standard web method `window.top.location.href = window.location.href` is the correct approach to escape the iframe and take over the tab.
- **"Universal URL"**: This likely refers to the main entry point for Lightspeed Retail: `https://us.merchantos.com/`. When a logged-in user navigates here, they are redirected to their last active screen (usually the Register).
- **Return to Menu**: To go back, the app should navigate the browser to `https://us.merchantos.com/?name=register` or just `https://us.merchantos.com/`.
- **Access Token**: The token obtained from the dev page is for the REST API (used in `routes.js` for sales/verification) and is not needed for the browser navigation itself (session cookies handle that).

## Proposed Prompt for Claude
The prompt will instruct Claude to:
1.  **Implement "Break Out"**: Ensure the app checks if it's in an iframe and offers a way to "expand" or automatically break out if desired (user's current code does this automatically).
2.  **Implement "Return to POS"**: Add a "Close" or "Back to Register" button that navigates `window.location` to `https://us.merchantos.com/?name=register`.
3.  **Safety**: Wrap these navigations in checks to ensure they only run when appropriate (e.g., don't break out if running in a normal browser tab for testing).

## Detailed Prompt Draft
```markdown
You are an expert in Lightspeed Retail (R-Series) integrations.
I have a scanner app running inside a Lightspeed Custom Button iframe.
I need to implement two key navigation features without breaking existing functionality:

1. **Break Out (Fullscreen)**:
   - The app is currently constrained in a small iframe.
   - I need it to "break out" to the top-level window to use the full screen for the camera.
   - Use `window.top.location.href = window.location.href` but ensure it only happens when explicitly triggered or if the app detects it's in the iframe.

2. **Return to Menu (Close Scanner)**:
   - Once the scan is complete or the user clicks "Close", I need to return to the Lightspeed Register.
   - The "Universal URL" to return to is `https://us.merchantos.com/?name=register`.
   - Implement a function `returnToLightspeed()` that navigates the window to this URL.

**Constraints**:
- Do not modify the core scanning logic.
- Ensure the `accessToken` I have is used for the API calls (already in `routes.js`) but doesn't need to be passed in the navigation URL.
- Handle the case where the app is running locally (localhost) vs in production—don't try to redirect to MerchantOS if I'm just testing on localhost.
```

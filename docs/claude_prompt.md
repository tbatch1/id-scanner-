# Prompt for Claude Code

You are an expert in Lightspeed Retail X-Series (formerly Vend) integrations, specifically for **iPad/iOS App** environments.
I have a web-based ID scanner app (`scanner.html`) that runs inside a Lightspeed Custom Button iframe.
The user has confirmed that the **iframe breakout is already working**.
The specific goal is to implement the **"Return to Register"** functionality for the **iPad App**.

### Context
- **Product**: Lightspeed Retail X-Series (Vend) running on **iPad (iOS App)**.
- **Environment**: The iOS app essentially wraps the web view.
- **Current State**: The app successfully "breaks out" to full screen (likely via `window.top.location`).
- **Problem**: We need a reliable way to "close" the scanner and return to the POS Sell Screen without getting stuck.

### Task: Implement "Return to Register"

1.  **Add/Update "Close" Button Logic**:
    - In `frontend/scanner.html`, ensure there is a "Close Scanner" or "Return to Register" button.
    - When clicked, this button must navigate the browser view back to the Lightspeed Sell Screen.

2.  **Target URL (The "Universal" Return)**:
    - Use the web URL: `https://retail.lightspeed.app/sell`
    - **Why?** Since the iOS app wraps the web interface, navigating `window.location` to this URL effectively tells the app to "go back to the start" (the Sell screen).
    - **Do NOT use `window.close()`**: This often fails in the iOS app wrapper because the scanner is now the "top" window, not a popup.

3.  **Implementation Details**:
    - Create a function `closeScanner()`:
      ```javascript
      function closeScanner() {
          // Check if running locally to avoid breaking dev workflow
          if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
              console.log("[DEV] Would return to: https://retail.lightspeed.app/sell");
              alert("Closing scanner -> Returning to Lightspeed POS");
              return;
          }
          
          // Force navigation back to the main Sell screen
          // This works even inside the iOS app wrapper as it resets the webview
          window.location.href = "https://retail.lightspeed.app/sell";
      }
      ```
    - Bind this function to the "Close" button.

### Constraints
- **Do NOT touch the scanning logic.**
- **Do NOT touch the API routes.**
- **Safety**: Ensure the navigation only happens when intended.

### Summary of Changes for Claude
- Edit `frontend/scanner.html`:
    - Update `closeScanner()` to navigate to `https://retail.lightspeed.app/sell`.

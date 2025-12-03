# Lightspeed Scanning: Alternative Gameplans

Since the "iframe breakout" method is proving unreliable ("dead frame" issues), here are 3 alternative options to get ID scanning working smoothly on iPad.

## Option 1: The "Companion App" (Recommended)
**Concept**: Run the scanner as a separate "Web Clip" (app icon) on the iPad home screen, side-by-side with Lightspeed.
**Workflow**:
1.  **Start**: Cashier opens the "ID Scanner" app (Safari web clip) from the dock.
2.  **Scan**: Scans the ID.
3.  **Process**: The scanner uses the Lightspeed API to find the *active* sale and adds the verification details (Name, Age, Status) as a **Note** or **Customer** to the sale.
4.  **Return**: Cashier double-taps home (or swipes) to switch back to Lightspeed. The sale is already updated.

*   **Pros**:
    *   **100% Reliable**: No fighting with iframes or "dead frames".
    *   **Full Screen**: Camera always works perfectly in Safari.
    *   **No Code Changes**: Your current backend already has the API logic to update sales.
*   **Cons**:
    *   **Manual Switch**: Requires a swipe/double-tap to switch apps (2 seconds).
    *   **Sale Selection**: Scanner needs to know *which* sale to update (can ask user to "Select Register" once at start of shift).

## Option 2: The "Redirect API" Deep Link
**Concept**: Use Lightspeed's official iOS integration to open the app.
**Workflow**:
1.  **Start**: Cashier clicks "Scan ID" in Lightspeed (Custom Button).
2.  **Break Out**: Opens Scanner in a new Safari tab (not iframe).
3.  **Scan**: Scans ID.
4.  **Return**: Scanner redirects to a special URL: `https://retail.lightspeed.app/sales/{sale_id}?platform=ios&action=view`.
5.  **Result**: iOS automatically switches back to the Lightspeed App and opens that specific sale.

*   **Pros**:
    *   **Automated Return**: No manual swiping; the link forces the app to open.
    *   **Native Feel**: Uses official Lightspeed iOS hooks.
*   **Cons**:
    *   **Complex Setup**: Requires the scanner to know the exact `sale_id` (which we can get from the initial button click).
    *   **Redirect Warning**: Safari might ask "Open in Lightspeed?" each time.

## Option 3: The "Keyboard Emulation" (Hardware Mode)
**Concept**: Treat the scanner like a bluetooth keyboard.
**Workflow**:
1.  **Start**: Cashier taps the "Add Note" field in Lightspeed.
2.  **Scan**: Scans ID.
3.  **Process**: The scanner (if it supports this mode) "types" the Name/DOB directly into the note field.

*   **Pros**: Zero custom code.
*   **Cons**: Requires specific hardware (bluetooth scanner) or a very complex software keyboard implementation. Likely not viable for a web-based camera scanner.

## Recommendation
**Go with Option 1 (Companion App)** to start. It is the most robust. If the "swiping" is too slow, we can upgrade it to **Option 2** by adding the "Deep Link" return button.

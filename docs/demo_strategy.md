# Demo Strategy: Lightspeed Scanner Integration

**Objective**: Present 3 distinct workflows to the client to determine the best "feel" for their daily operations. All options use the **Lightspeed Redirect API** to ensure data integrity.

## Option A: The "New Tab" Workflow (Preserves State)
**Best for**: Speed and keeping the POS "ready" in the background.
**Concept**: The scanner opens in a fresh browser tab. The Lightspeed POS stays open and untouched in the background.

**The Flow**:
1.  **Trigger**: User clicks "Scan ID" in Lightspeed.
2.  **Action**: The button opens the Scanner URL in a **New Tab** (`target="_blank"`).
3.  **Scan**: User scans the ID. The sale is updated in the background via API.
4.  **Return**: User clicks "Return to POS".
5.  **Technical**: The scanner navigates to the **Deep Link** (`https://retail.lightspeed.app/sales/{id}?platform=ios&action=view`).
6.  **Result**: The iPad automatically switches focus back to the original Lightspeed App (or tab), showing the updated sale.

**Pros**:
*   Lightspeed never reloads (it was just in the background).
*   Very fast "switch back".
**Cons**:
*   Opens a new tab every time (staff might need to close them eventually).

---

## Option B: The "Same Tab" Workflow (Single Focus)
**Best for**: Simplicity and avoiding "tab clutter".
**Concept**: The scanner takes over the current window. There is only ever one active screen.

**The Flow**:
1.  **Trigger**: User clicks "Scan ID".
2.  **Action**: The current window navigates to the Scanner URL (`target="_self"`). Lightspeed is replaced.
3.  **Scan**: User scans the ID.
4.  **Return**: User clicks "Return to POS".
5.  **Technical**: The scanner navigates to the **Deep Link**.
6.  **Result**: The browser reloads the Lightspeed App from scratch, landing directly on the specific Sale.

**Pros**:
*   Cleaner interface (no extra tabs).
*   Feels like a single, cohesive app flow.
**Cons**:
*   **Slower**: Lightspeed has to reload its resources every time you return.

---

## Option C: The "Slide Over" Workflow (iPad Multitasking)
**Best for**: Power users who want zero friction.
**Concept**: Use iPad's native multitasking to keep the scanner floating on top of Lightspeed.

**The Flow**:
1.  **Setup**: User opens Lightspeed. User drags the Scanner (saved as a Web Clip) into "Slide Over" view (floating window on the right).
2.  **Trigger**: User swipes from the right to reveal the Scanner.
3.  **Scan**: User scans the ID.
4.  **Return**: User swipes the scanner away (to the right).
5.  **Result**: The sale is updated via API. The user is instantly back in Lightspeed (it never left).

**Pros**:
*   **Fastest** possible workflow (0.5 seconds to switch).
*   No reloading, no new tabs.
**Cons**:
*   Requires "Slide Over" setup (might be tricky for some staff).
*   Scanner covers part of the POS screen while active.

---

## Technical Implementation Plan (For the Demo)
To demo these, we only need to change **one line of code** in the Custom Button setup and the Scanner:

1.  **For Option A**: Set Custom Button to Open URL in `New Tab`.
2.  **For Option B**: Set Custom Button to Open URL in `Current Tab`.
3.  **For Option C**: No code change. Just save the Scanner URL to the iPad Home Screen.

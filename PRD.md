# Slot Sentinel — Product Requirements Document

## What

**Slot Sentinel** is a Chrome/Edge MV3 browser extension that monitors `login.noon.partners` for slot availability changes. When the page transitions from a "sold out" state to having available slots, the extension instantly highlights, scrolls to, and focuses the best booking button—reducing the user's reaction time to a single click or keypress.

## Why

On the Noon seller portal, popular time-slots sell out within seconds. Manually refreshing and scanning for availability is slow and error-prone. This extension watches for DOM changes in real-time and prepares the page so the user only needs to press Enter or click.

## Core Principles

| Principle | Implementation |
|---|---|
| **Human-in-the-loop** | Final booking action is always a user click/keypress. No auto-submit. |
| **No stealth/bypass** | No captcha solving, fingerprint spoofing, or webdriver automation. |
| **Minimal footprint** | MutationObserver primary, low-frequency fallback polling (25–55s jitter). |
| **Whitelisted scope** | Only runs on `https://login.noon.partners/*`. |
| **Transparent** | Full activity log, clear armed/paused status, safety auto-pause. |

## Detection Logic

### Sold-Out State
Scans for case-insensitive patterns: `No slots available`, `Sold out`, `Full`.  
Prefers scanning slot/calendar containers; falls back to `document.body.innerText`.

### Available State
Finds enabled buttons/links matching keywords: `book`, `select`, `reserve`, `choose`, `confirm`, `continue`.  
Ranks candidates by: viewport visibility > keyword priority > proximity to slot container > clickable area size.

### Transition Trigger
Triggers only when sold-out text disappears AND/OR ranked clickable candidates appear.  
150–300ms debounce prevents false positives.

## Speed-Assist Features

1. **Auto-scroll** target button to viewport center
2. **Auto-focus** the highest-ranked button
3. **Green glow highlight** with pulse animation
4. **Floating "SLOTS!" label** near the button
5. **Toast notification** (non-blocking, bottom-right)
6. **Subtle screen flash** (green overlay, 400ms)
7. **Title flash** (`⚡ SLOTS AVAILABLE` alternating for 3s)
8. **Optional audio beep** (880Hz square wave, 250ms)

## Safety Controls

- Throttle: max 1 detection per 250ms under MutationObserver storms
- 10-second cooldown after detection to prevent spam
- Auto-pause on anti-bot signals: `Access denied`, `429`, `Too many requests`, `Robot`, `Captcha`
- Red safety banner with 15-second display
- User can re-arm manually after safety pause

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+S` | Focus & cycle through available slot buttons |
| `Alt+P` | Toggle monitoring (pause/resume) |
| `Alt+H` | Toggle highlight overlay |
| `Enter/Space` | Click focused button (native browser behavior) |

## Permissions (Minimal)

- `storage` — persist settings and logs
- `activeTab` — interact with the current tab
- `notifications` — optional desktop notifications
- Host: `https://login.noon.partners/*`

## File Structure

```
slot-sentinel/
├── manifest.json          MV3 manifest
├── service_worker.js      Background script (commands, state, notifications)
├── content_script.js      DOM detection, highlighting, focus, hotkeys
├── styles.css             Injected highlight/toast/flash styles
├── popup.html             Extension popup UI
├── popup.js               Popup logic (toggles, logs, state display)
├── icons/
│   ├── icon16.png         16×16 toolbar icon
│   ├── icon48.png         48×48 icon
│   └── icon128.png        128×128 icon
└── PRD.md                 This document
```

---

## How to Load (Unpacked Extension)

### Chrome
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the extension folder
5. Navigate to `https://login.noon.partners/` — the extension activates automatically

### Edge
1. Open `edge://extensions/`
2. Enable **Developer mode** (bottom-left toggle)
3. Click **Load unpacked**
4. Select the extension folder
5. Navigate to the target site

### Verify Shortcuts
- Chrome: `chrome://extensions/shortcuts`
- Edge: `edge://extensions/shortcuts`
- Remap `Alt+S`, `Alt+P`, `Alt+H` if they conflict with other extensions

---

## Troubleshooting Guide

### Selector Mismatch
**Symptom**: Extension shows "Monitoring…" but never detects buttons.  
**Fix**: Open DevTools (F12) → Inspect the booking button → Check its tag, classes, and text. Update `LABEL_KEYWORDS` in `content_script.js` to include the button's label text. If the button uses a custom element instead of `<button>`, add its selector to the `selectors` array in `detectAvailableButtons()`.

### SPA Navigation
**Symptom**: Extension stops working after navigating within the portal without a full page reload.  
**Fix**: The extension includes a URL-change observer that re-runs detection on navigation. If it's still not firing, the SPA may use hash-based routing. Add a `hashchange` listener in `content_script.js`:
```js
window.addEventListener("hashchange", () => {
  currentState = "UNKNOWN";
  setTimeout(runDetection, 500);
});
```

### Focus Not Working
**Symptom**: Button highlights but doesn't receive keyboard focus.  
**Fix**: Some frameworks intercept focus. Check if the element is inside a Shadow DOM — if so, you need `el.shadowRoot.querySelector(...)`. Also verify the element isn't behind an overlay (`z-index` issue). The extension adds `tabindex="-1"` temporarily; if the framework removes it, increase the delay before focus (currently 120ms).

### Multiple Buttons Found
**Symptom**: Wrong button gets highlighted/focused.  
**Fix**: The ranking algorithm scores by: viewport visibility (100pts), keyword position (up to 60pts), slot container proximity (50pts), clickable area (up to 30pts). To bias toward a specific button:
1. Add its unique class to a higher-priority check
2. Or increase the weight for slot-container proximity
3. Use `Alt+S` to cycle through all candidates

### No Desktop Notifications
**Symptom**: Notification mode set to "Desktop" but nothing appears.  
**Fix**: Check Chrome notification permissions at OS level (Windows: Settings → Notifications → Google Chrome). Also ensure `notifications` permission is granted in the extension details page.

---

## How to Adapt Selectors Safely

### Step 1: Inspect the DOM
1. Navigate to the page where slots appear
2. Right-click the booking button → **Inspect**
3. Note the element tag, classes, text, and parent structure

### Step 2: Update Sold-Out Patterns
In `content_script.js`, find `SOLD_OUT_PATTERNS`:
```js
const SOLD_OUT_PATTERNS = [
  /no\s+slots?\s+available/i,
  /sold\s+out/i,
  /\bfull\b/i,
];
```
Add or modify regexes to match the exact text shown on your page.

### Step 3: Update Button Keywords
Find `LABEL_KEYWORDS`:
```js
const LABEL_KEYWORDS = [
  "book", "reserve", "select", "choose", "confirm", "continue",
];
```
Add new keywords at the beginning for higher priority.

### Step 4: Update Button Selectors
Find the `selectors` array in `detectAvailableButtons()`:
```js
const selectors = [
  'button:not([disabled]):not([aria-disabled="true"])',
  'a[role="button"]:not([aria-disabled="true"])',
  '[role="button"]:not([aria-disabled="true"])',
  'input[type="submit"]:not([disabled])',
];
```
Add custom selectors for the portal's specific button elements.

### Step 5: Update Container Heuristics
Find the `nearSlotContainer` check:
```js
const nearSlotContainer = !!el.closest(
  '[class*="slot"], [class*="time"], [class*="date"], [class*="calendar"], [class*="schedule"]'
);
```
Add class fragments that match the portal's slot list container.

### Step 6: Test
1. Use the **Test Highlight** button in the popup to verify styling works
2. Use **Force Check** to re-run detection immediately
3. Check the **Activity Log** for detection results and matched selectors

# Web Layout Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize web layout to fill viewport with fixed structure and scrollable internal content using CSS Grid.

**Architecture:** Pure CSS changes using CSS Grid layout. No component logic changes. HTML structure remains unchanged. Four CSS files modified to enable full-viewport layout with internal scrollable regions.

**Tech Stack:** CSS Grid, Flexbox, React + TypeScript (unchanged), xterm.js (unchanged)

---

## File Structure

**Files to Modify:**
- `web/src/index.css` - Root level viewport setup (html, body, #root)
- `web/src/App.css` - Remove width constraints, clean up terminal wrapper
- `web/src/components/Dashboard.css` - CSS Grid layout for dashboard and terminal views
- `web/src/components/Terminal.css` - Remove hardcoded dimensions, let terminal fill parent

**No files to create.** All changes are modifications to existing CSS files.

---

### Task 1: Root Level Viewport Setup

**Files:**
- Modify: `web/src/index.css`

- [ ] **Step 1: Update index.css to enable full-viewport layout**

Replace the existing `body` and `#root` rules with:

```css
html, body {
  height: 100%;
  margin: 0;
  overflow: hidden; /* Prevent page-level scrolling */
}

#root {
  height: 100%;
  width: 100%;
  max-width: none; /* Remove 1280px constraint */
}
```

Keep the rest of the file unchanged (root variables, button styles, media queries).

- [ ] **Step 2: Verify the changes**

Run: `cat web/src/index.css | grep -A 10 "html, body"`

Expected output should show:
```css
html, body {
  height: 100%;
  margin: 0;
  overflow: hidden;
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/index.css
git commit -m "feat: enable full-viewport layout at root level

- Set html, body to 100% height with overflow hidden
- Remove 1280px max-width constraint from #root
- Prevent page-level scrolling"
```

---

### Task 2: Remove Width Constraints from App.css

**Files:**
- Modify: `web/src/App.css`

- [ ] **Step 1: Update the #root rule in App.css**

Find the `#root` rule (around line 1-6) and change it to:

```css
#root {
  max-width: none;  /* Was: 1280px */
  margin: 0;  /* Was: 0 auto */
  padding: 0;  /* Was: 2rem */
  text-align: left;  /* Keep existing value */
}
```

- [ ] **Step 2: Delete the .terminal-wrapper rule**

Find and delete the `.terminal-wrapper` rule (around line 225-229):

```css
/* DELETE THIS ENTIRE RULE */
.terminal-wrapper {
  height: 500px;
  border-radius: 6px;
  overflow: hidden;
}
```

- [ ] **Step 3: Verify the changes**

Run: `cat web/src/App.css | grep -A 5 "#root"`

Expected output should show:
```css
#root {
  max-width: none;
  margin: 0;
  padding: 0;
  text-align: left;
}
```

Run: `grep -n "terminal-wrapper" web/src/App.css`

Expected: No output (rule deleted)

- [ ] **Step 4: Commit**

```bash
git add web/src/App.css
git commit -m "feat: remove width constraints and terminal hardcoded height

- Remove 1280px max-width from #root
- Remove padding and auto margins
- Delete .terminal-wrapper rule (unused)"
```

---

### Task 3: CSS Grid Layout for Dashboard View

**Files:**
- Modify: `web/src/components/Dashboard.css`

- [ ] **Step 1: Update .dashboard to use CSS Grid**

Find the `.dashboard` rule (around line 3-9) and replace it with:

```css
.dashboard {
  display: grid;
  grid-template-rows: auto 1fr;  /* header auto, panels fill remaining */
  height: 100%;
  overflow: hidden;
  background-color: #1a1a2e;
  color: #e0e0e0;
}
```

- [ ] **Step 2: Update .dashboard-panels to use CSS Grid**

Find the `.dashboard-panels` rule (around line 91-97) and replace it with:

```css
.dashboard-panels {
  display: grid;
  grid-template-columns: 260px 1fr;  /* agents fixed 260px, sessions fills rest */
  gap: 1rem;
  padding: 1rem 1.5rem;
  flex: 1;
  min-height: 0;  /* Required for grid children to shrink */
  overflow: hidden;  /* Prevent panels from overflowing */
}
```

- [ ] **Step 3: Update .terminal-view to use CSS Grid**

Find the `.terminal-view` rule (around line 330-336) and replace it with:

```css
.terminal-view {
  display: grid;
  grid-template-rows: auto 1fr;  /* header auto, terminal fills remaining */
  height: 100%;
  overflow: hidden;
  background-color: #1a1a2e;
  color: #e0e0e0;
}
```

- [ ] **Step 4: Update .terminal-view-body**

Find the `.terminal-view-body` rule (around line 391-395) and replace it with:

```css
.terminal-view-body {
  flex: 1;
  min-height: 0;
  padding: 0;  /* Remove padding so terminal fills completely */
  overflow: hidden;
}
```

- [ ] **Step 5: Verify the changes**

Run: `cat web/src/components/Dashboard.css | grep -A 6 "^\.dashboard {"`

Expected output should show:
```css
.dashboard {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  overflow: hidden;
  background-color: #1a1a2e;
  color: #e0e0e0;
}
```

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Dashboard.css
git commit -m "feat: implement CSS Grid layout for dashboard and terminal views

- Dashboard uses grid with auto header and 1fr panels area
- Dashboard panels use grid with 260px agents and 1fr sessions
- Terminal view uses grid with auto header and 1fr terminal area
- Remove padding from terminal-view-body for full-bleed terminal"
```

---

### Task 4: Remove Hardcoded Dimensions from Terminal Component

**Files:**
- Modify: `web/src/components/Terminal.css`

- [ ] **Step 1: Update .nession-terminal to fill parent**

Find the `.nession-terminal` rule (around line 8-18) and replace it with:

```css
.nession-terminal {
  width: 100%;
  height: 100%;  /* Fill parent container */
  min-height: 0;  /* Allow shrinking */
  display: flex;
  flex-direction: column;
  border: none;  /* Remove border for full-bleed look */
  border-radius: 0;  /* Remove border radius */
  overflow: hidden;
  background-color: #1e1e2e;
}
```

- [ ] **Step 2: Verify the changes**

Run: `cat web/src/components/Terminal.css | grep -A 9 "^\.nession-terminal {"`

Expected output should show:
```css
.nession-terminal {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: none;
  border-radius: 0;
  overflow: hidden;
  background-color: #1e1e2e;
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Terminal.css
git commit -m "feat: remove hardcoded dimensions from terminal component

- Terminal fills parent container with 100% width/height
- Remove border and border-radius for full-bleed appearance
- Allow terminal to shrink with min-height: 0"
```

---

### Task 5: Visual Verification

**Files:**
- No files modified (verification only)

- [ ] **Step 1: Start the development server**

Run: `cd web && npm run dev`

Expected: Server starts, displays local URL (e.g., http://localhost:5173)

- [ ] **Step 2: Open browser and verify layout**

Open the URL in a browser. Verify:

1. **No page-level scrollbar** - The browser window never scrolls
2. **App fills viewport** - Application occupies 100vh × 100vw
3. **Dashboard view** - Header visible, agents panel (260px) on left, sessions panel fills remaining space
4. **Internal scrolling** - Agents list and sessions list scroll independently within their panels
5. **Terminal view** - Click "Attach" on a session, verify:
   - Header with back button is visible
   - Terminal fills all remaining space below header
   - Terminal content scrolls internally (xterm.js handles this)
6. **Resize behavior** - Resize browser window, verify terminal adapts correctly

- [ ] **Step 3: Take screenshots for documentation (optional)**

If needed, take screenshots of:
- Dashboard view showing the layout
- Terminal view showing full-bleed terminal
- Scrolling behavior in action

- [ ] **Step 4: Stop the development server**

Press `Ctrl+C` in the terminal where the server is running.

- [ ] **Step 5: Final commit (if any adjustments needed)**

If any adjustments were made during verification:

```bash
git add web/src/
git commit -m "fix: adjust layout based on visual verification"
```

If no adjustments needed, skip this step.

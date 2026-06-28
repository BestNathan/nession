# Web Layout Optimization Design

**Date**: 2026-06-28  
**Topic**: Optimize web layout to fill viewport with fixed structure and scrollable internal content

## Problem Statement

The current web layout has several issues:
- Content is constrained to `max-width: 1280px` and doesn't fill the screen
- No fixed viewport structure - the page can scroll
- Terminal component has hardcoded `height: 500px` instead of filling available space
- Internal content (agent/session lists) needs proper scrollable containers

## Requirements

1. **Fill viewport**: Application should fill 100vh × 100vw
2. **Fixed viewport**: No page-level scrolling - browser window never scrolls
3. **Internal scrolling**: Specific sections (agents list, sessions list) have their own scrollbars
4. **Terminal fills space**: Terminal component occupies all available space below header
5. **Terminal internal scrolling**: xterm.js handles command history/output scrolling internally (no CSS changes needed for this)
6. **Dashboard panels**: Fixed ratio layout (agents 260px, sessions fills remaining)

## Design: CSS Grid Layout Approach

### Overall Architecture

HTML structure remains unchanged. Only CSS modifications are needed.

```html
<html>
  <body>
    <div id="root">
      <div class="dashboard"> or <div class="terminal-view">
        ...
      </div>
    </div>
  </body>
</html>
```

### Core CSS Changes

#### 1. Root Level (index.css)

Remove viewport centering and enable full-height layout:

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

#### 2. Dashboard View (Dashboard.css)

Use CSS Grid for two-row layout:

```css
.dashboard {
  display: grid;
  grid-template-rows: auto 1fr;  /* header auto, panels fill remaining */
  height: 100%;
  overflow: hidden;
}

.dashboard-header {
  /* Unchanged - auto height */
}

.dashboard-panels {
  display: grid;
  grid-template-columns: 260px 1fr;  /* agents fixed 260px, sessions fills rest */
  gap: 1rem;
  padding: 1rem 1.5rem;
  overflow: hidden;  /* Prevent panels from overflowing */
  min-height: 0;  /* Required for grid children to shrink */
}

.panel-body {
  overflow-y: auto;  /* Only list content scrolls internally */
}
```

**Result**:
- Header fixed height
- Agents panel fixed 260px width, internal list scrollable
- Sessions panel fills remaining space, internal list scrollable
- No page scrollbar, only panel-internal scrollbars

#### 3. Terminal View (Dashboard.css)

Use CSS Grid for two-row layout with terminal filling remaining space:

```css
.terminal-view {
  display: grid;
  grid-template-rows: auto 1fr;  /* header auto, terminal fills remaining */
  height: 100%;
  overflow: hidden;
}

.terminal-view-header {
  /* Unchanged - auto height */
}

.terminal-view-body {
  padding: 0;  /* Remove padding so terminal fills completely */
  overflow: hidden;
  min-height: 0;  /* Required for grid children to shrink */
}
```

#### 4. Terminal Component (Terminal.css)

Remove hardcoded dimensions and let terminal fill parent:

```css
.nession-terminal {
  width: 100%;
  height: 100%;  /* Fill parent container */
  border: none;  /* Remove border for full-bleed look */
  border-radius: 0;
}

.nession-terminal-container {
  flex: 1;
  padding: 8px;
  min-height: 0;
}
```

**Result**:
- Header (with back button) stays visible
- Terminal component fills all remaining space
- xterm.js automatically adapts to container size
- Terminal content scrolling handled by xterm.js internally

#### 5. App.css Cleanup

Modify the `#root` rule to remove width constraints:

```css
#root {
  max-width: none;  /* Change from: 1280px */
  margin: 0;  /* Change from: 0 auto */
  padding: 0;  /* Remove padding (was: 2rem) */
}
```

Delete the `.terminal-wrapper` rule entirely (it's not used in the current codebase).

## Files to Modify

1. `web/src/index.css` - Root level viewport setup
2. `web/src/App.css` - Remove width constraints, clean up terminal wrapper
3. `web/src/components/Dashboard.css` - CSS Grid layout for dashboard and terminal views
4. `web/src/components/Terminal.css` - Remove hardcoded dimensions

## Testing Considerations

- Verify no page-level scrollbar appears
- Verify agents/sessions lists scroll internally
- Verify terminal fills available space
- Verify terminal resizes correctly when window resizes
- Verify xterm.js fit addon works with new layout
- Verify existing mobile responsive behavior still works (media queries may need minor adjustments for grid layout)

## Out of Scope

- Changes to component logic (React/TypeScript code)
- Changes to WebSocket or terminal connection behavior
- Changes to xterm.js configuration
- Major mobile responsive layout redesign (existing media queries will be preserved and may receive minor adjustments to work with grid layout)

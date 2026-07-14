# WebUI 响应式布局重构 — Design

**Issue:** #44 (Requirement: WebUI 响应式布局重构)
**Date:** 2026-07-14
**Author:** Nathan (brainstormed with Claude)
**Status:** Approved design → ready for implementation plan

---

## 1. Context & Scope Correction

Issue #44 predates PR #49 (`feat/terminal-responsive-layout`, merged 2026-07-10). **A large part of the issue's Terminal work is already shipped:**

- `web/src/terminal/DeviceProfile.ts` — phone/tablet/desktop profiles (`fontSize` 11/13/14, `lineHeight`, `scrollback`) with `detectProfile(containerWidth)` and breakpoints `TABLET_BREAKPOINT=640`, `DESKTOP_BREAKPOINT=1024`.
- `web/src/terminal/ViewportManager.ts` — `ResizeObserver` + rAF-debounced fit, dynamic font clamp (`FONT_MIN=10`, `FONT_MAX=14`), FitAddon reflow, wheel-scroll intercept. This *is* the "信息量(cols×rows)接近" strategy from the issue.
- `web/src/components/TerminalView.tsx` — header already uses `px-2 sm:px-4 ... flex-wrap`; `BottomBar` already collapses on mobile via a sheet toggle (`sheetOpen ? 'block' : 'hidden sm:block'`) with an expand/collapse chevron.

The issue's premise that `Terminal.tsx` hardcodes `fontSize: 14` is **stale** — `Terminal.tsx` now delegates to the `../terminal` module (`detectProfile`, `deviceProfile`, `targetColumns`).

**This design is FULL SCOPE** (per user decision): it treats the whole issue as open, including *verifying and tuning* the already-merged terminal font strategy against the issue's cols×rows targets — but without rewriting `ViewportManager`'s architecture. The bulk of *new* work is on the **Dashboard / Login / Dialog / Sheet / Toaster** surfaces, which are still untouched.

### Resolved Open Questions (from issue)

| # | Question | Decision |
|---|----------|----------|
| 1 | Mobile Dashboard navigation | **Collapsible Agents section** — compact summary bar (counts + chevron), expands on tap; default collapsed on mobile so Sessions gets the screen. Grid always shown at `md:`+. |
| 2 | Terminal full-screen mode on mobile | **No new mode.** Auto-collapsing chrome only — compact header + existing BottomBar collapse. |
| 3 | Mobile SessionList actions | **Keep both buttons, sized up** to 44px, stacked full-width below metadata on mobile. Kill still via `KillConfirmDialog`. No swipe/long-press. |

---

## 2. Strategy & Breakpoints

**Mobile-first Tailwind.** Base (unprefixed) utilities target phones; tablet overrides at `md:`; desktop at `lg:`. **Every current desktop value is re-expressed at `lg:` as a direct copy of today's class**, so desktop cannot regress.

| Class | Width | Device |
|-------|-------|--------|
| (base) | <768px | Mobile |
| `md:` | 768–1023px | Tablet |
| `lg:` | ≥1024px | Desktop |
| `sm:` | ≥640px | used sparingly (large-phone landscape, e.g. SearchBar filter row) |

**Foundational utilities (in `web/src/index.css`):**

1. **Dynamic viewport height** — replace `height: 100%` on `html, body, #root` (currently `index.css:132-136`) and every `h-screen` / `min-h-screen` (Dashboard, TerminalView, EnvManager, LoginPage) with `100dvh`, so the mobile address bar showing/hiding doesn't clip or jump the layout. Keep `overflow: hidden` on the root.
2. **Safe-area insets** — use `env(safe-area-inset-bottom)` padding for iOS notch/home-indicator, applied to the Dashboard scroll container bottom, the TerminalView BottomBar, and the AgentDetailPanel Sheet content. Requires `viewport-fit=cover` in the viewport meta tag (verify/add in `web/index.html`).

**Touch targets:** interactive controls get `min-h-11` (44px, WCAG 2.5.5) at base, shrinking to current compact sizes at `md:`/`lg:`.

**Constraints (from issue):** modern browsers only (Chrome 90+/Safari 15+/Firefox 90+); Tailwind v4 + existing shadcn/ui only, **no new dependencies**; single PR; do not touch WebSocket/backend, Catppuccin terminal theme, or shadcn base components.

---

## 3. Component-by-Component Changes

### 3.1 `index.css`
- `html, body, #root { height: 100%; }` → `height: 100dvh;` (keep `overflow: hidden`, `margin: 0`).
- Add a safe-area padding helper (Tailwind v4 `@utility` or inline `pb-[env(safe-area-inset-bottom)]` at call sites).

### 3.2 `Dashboard.tsx`
- Root `h-screen` (line 235) → `h-[100dvh]`.
- Content wrapper `p-6 gap-6` (line 250) → `p-3 gap-4 md:p-4 lg:p-6 lg:gap-6`. Add `pb-[env(safe-area-inset-bottom)]`.
- Inner content max width: `max-w-[1920px] mx-auto` to prevent over-stretch on ultra-wide (>2560px edge case).
- **DashboardHeader:** stays a single row. "Env Files" button collapses to icon-only on mobile (drop text label via `hidden md:inline`, keep `FileCog` icon). Buttons `min-h-11 md:min-h-9`.

### 3.3 `AgentSection` (inside `Dashboard.tsx`) — collapsible on mobile
- Collapse is pure CSS + one state var (no viewport-measuring JS), so it works under jsdom and needs no `matchMedia` mock.
- One JS state var: `useState` `expanded`, default `false`.
- **Summary bar:** a tappable row `● {onlineCount} online · ○ {offlineCount} offline` with a chevron. Class `md:hidden` — visible only on mobile. Tapping toggles `expanded`.
- **Grid wrapper:** class **`${expanded ? 'grid' : 'hidden'} md:grid ...`** — on mobile it's `grid` only when `expanded` (else `hidden`); at `md:`+ the `md:grid` always wins, so the grid is unconditionally visible on tablet/desktop regardless of `expanded`. This needs no viewport JS — one state var + responsive display classes cover all three devices.
- Grid classes (both real grid and skeleton grid): `grid-cols-2 lg:grid-cols-4` → **`grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4`** (`lg:grid-cols-4` = today's desktop value).

### 3.4 `SearchBar.tsx`
- Current single `flex` row can overflow at 320px.
- Base: input on its own row; filter buttons on a second row that horizontally scrolls (`flex flex-nowrap overflow-x-auto`) so All/Online/Offline never wrap-break. Filter buttons `min-h-11`.
- `sm:`+: return to current inline single-row layout (`sm:flex-row`, buttons `sm:min-h-9`).

### 3.5 `SessionList.tsx`
- `ScrollArea` `max-h-64` (line 60) → `flex-1 min-h-0` so the list fills space freed by the collapsed Agents section (parent `SessionsSection` is already `flex-1 min-h-0 flex flex-col`).
- **Header row:** hide the "Activity" sort column on mobile (`hidden md:flex`); keep "Name" sort. Activity sort returns at `md:`.
- **Data rows:** `flex items-center` → `flex flex-col md:flex-row md:items-center`. Metadata block on top; action buttons on a full-width row below on mobile. Attach/Kill: `min-h-11 flex-1` on mobile, `md:min-h-8 md:flex-none` at tablet+ (current compact size). Kill routes through existing `KillConfirmDialog`.

### 3.6 `ui/dialog.tsx` + `CreateSessionDialog.tsx` / `KillConfirmDialog.tsx`
- Dialog content already `max-w-[calc(100%-2rem)]`. Add `max-h-[calc(100dvh-2rem)] overflow-y-auto` so a tall form (CreateSessionDialog: agent select + name + env files) scrolls rather than overflowing at 375px.
- Footer buttons stack full-width on mobile (`flex-col sm:flex-row`) — verify shadcn footer already does this and pin it.
- CreateSessionDialog / KillConfirmDialog: inherit the above; verify at 375px; only touch-target button-height bumps expected.

### 3.7 `ui/sheet.tsx` + `AgentDetailPanel.tsx`
- Right/left side default `w-3/4 ... sm:max-w-sm` → **`w-full sm:w-3/4 sm:max-w-sm`** (full-bleed on phones, current behavior at `sm:`+).
- Add `pb-[env(safe-area-inset-bottom)]` to sheet content.

### 3.8 `TerminalView.tsx`
- `h-screen` (line 105) → `h-[100dvh]`.
- Header already `flex-wrap` with compact `sm:` padding — no structural change; verify it stays 1–2 compact rows at 375px.
- BottomBar already auto-collapses on mobile (this is the chosen "auto-collapsing chrome"). Add `pb-[env(safe-area-inset-bottom)]` to the BottomBar so the collapsed tab bar clears the iOS home indicator. Verify mobile keyboard doesn't cover terminal output (input lives in BottomBar sheet, above the fold).

### 3.9 `TerminalToolbar.tsx` — touch targets
- Quick-command buttons `h-6` (24px) → `h-11 md:h-6`; text `text-[11px]` → `text-xs md:text-[11px]`.
- Send button `h-7 w-7` → `h-11 w-11 md:h-7 md:w-7`.
- Add-form inputs likewise grow on mobile (`h-11 md:h-6`).

### 3.10 `main.tsx` — Toaster
- sonner `position` is a single non-responsive prop. Add a small `matchMedia`-driven hook so `position` = `top-center` under 768px, `bottom-right` at ≥768px — avoids the mobile browser bottom bar / BottomBar sheet covering toasts.

### 3.11 `LoginPage.tsx`
- `min-h-screen` (line 68) → `min-h-[100dvh]`.
- Connect card: keep `max-w-md`, ensure `w-full` minus `p-4` on mobile (already `w-full max-w-md`).
- **Drop the Features card on mobile** (`hidden md:block` on the second Card) to cut scrolling; keep at tablet+.

### 3.12 Terminal font strategy — verify + tune (no rewrite)
- Current: `DeviceProfile` fonts 11/13/14, breakpoints 640/1024; `ViewportManager` clamp `FONT_MIN=10`/`FONT_MAX=14`, `DEFAULT_TARGET_COLS=80`.
- Measure actual `term.cols × term.rows` at 375/768/1024/1440 via Playwright.
- Issue targets: **mobile (375px) ≥ 1000**, **desktop (1440px) ≥ 5000**.
- If a target is missed, tune profile constants only (e.g. raise `FONT_MAX` toward 15–16 for desktop density, or adjust phone `targetCols`/fontSize). No architectural change to `ViewportManager`.

---

## 4. Testing & Verification

### 4.1 Unit / component (Vitest)
- **SearchBar** — filter container has `overflow-x-auto` at base; inline at `sm:`.
- **AgentSection collapse** — clicking the summary bar toggles `expanded`; assert the grid wrapper's class flips between `hidden` and `grid` (the `md:grid` always-on behavior is a static class, not logic to test).
- **SessionList** — Activity header hidden on mobile (class assertion); rows stack action buttons (`flex-col md:flex-row`).
- **Toaster position hook** — returns `top-center` / `bottom-right` for the two `matchMedia` branches.
- **ViewportManager** — existing font-clamp tests remain green; add a cols×rows-target assertion if not already covered.
- Coverage threshold ≥80% (project standard) must hold.

### 4.2 Playwright MCP visual verification (mandatory, per CLAUDE.md)
Capture at **375, 768, 1024, 1440px** for every surface: LoginPage, Dashboard (Agents collapsed + expanded on mobile), SessionList, AgentDetailPanel (Sheet), CreateSessionDialog, KillConfirmDialog, TerminalView (chrome + collapsed BottomBar). Save to `.playwright-mcp/screenshots/` (gitignored); reference in PR **核心功能截图** section.

### 4.3 Acceptance checks (mapped to issue Success Criteria)
1. **No horizontal scroll** at ≥320px — assert `scrollingElement.scrollWidth <= clientWidth` at 320 & 375 via Playwright JS.
2. **Touch targets ≥44px** on mobile — measure button bounding boxes.
3. **Terminal fills space**, no fixed height — visual.
4. **AgentCard columns** — 1 / 2–3 / 4 across breakpoints.
5. **Dialog/Sheet** fits at 375px, scrolls if tall.
6. **4-viewport screenshots** correct for all surfaces.
7. **Desktop 1440px before/after diff** — capture `main` baseline first; compare after refactor; only intentional spacing diffs allowed.
8. **Terminal usable at 375px** — type command, see output, scroll history via Playwright.
9. **cols×rows measured** — 375px ≥1000, 1440px ≥5000, read from `term.cols`/`term.rows`.

### 4.4 Lint/build gates (project standard)
- `cd web && npm run lint` (`--max-warnings 0`, no `eslint-disable`), `npx tsc --noEmit`, `npm run build`, `npm test`.

---

## 5. Delivery

- Single PR (issue Constraint). Branch: `feat/webui-responsive-layout`.
- PR body: `Closes #44` + **核心功能截图** section with the 4-viewport screenshots.
- No k8s/image changes required (frontend-only).

---

## 6. Non-Goals (from issue, restated)

- No new responsive/mobile UI library — Tailwind v4 + shadcn/ui only.
- No new pages, no routing change.
- No WebSocket/backend change.
- No terminal Catppuccin Mocha theme change.
- No PWA / Service Worker / offline.
- No feature removal on mobile (功能完整保留).
- No change to shadcn base components (button/input/card/etc.).
- Not in scope: `EnvManager`, `EnvPanel`, `FileTabs`, `FileBrowser` (constrained by parents; touched only if they overflow at 375px during verification).

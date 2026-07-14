# Mobile File Browser — Bottom Bar Tab — Design

**Date:** 2026-07-14
**Author:** Nathan (brainstormed with Claude)
**Status:** Approved design → ready for implementation plan
**Branch:** `feat/mobile-file-browser-tab` (stacked on `feat/webui-responsive-layout` / PR #53, which added `useMediaQuery`)

---

## 1. Problem

On mobile (`<lg`, <1024px), the file browser is presented by `SidePanel` as a **left-sliding drawer** with a `bg-muted/30` background (only 30% opaque) over a `bg-black/40` backdrop. The terminal bleeds through the semi-transparent panel — it looks broken ("透明且在左边,太扯了"). The left-drawer model is also awkward on a phone.

## 2. Solution

Make the file browser a **third Bottom Bar tab — "Files"** — alongside the existing Commands / Env tabs, **on mobile only**. The Bottom Bar is opaque by construction (solid `bg-background`/border, safe-area padding) and is the established home for auxiliary panels on this app's mobile layout. Desktop is unchanged: the resizable left `SidePanel` stays.

This is a **mobile-only restructure**. No backend, protocol, or desktop behavior changes.

### Breakpoint split
- **Desktop (`lg:`+):** `SidePanel` + FileBrowser on the left (today's behavior, untouched). Bottom Bar shows Commands / Env only.
- **Mobile (`<lg`):** `SidePanel` is **not rendered** (the transparent drawer is gone). FileBrowser renders inside the Bottom Bar as the "Files" tab.

## 3. Architecture

### Current structure (the constraint)
- `TerminalView` owns the Bottom Bar state (`bottomTab`, `sheetOpen`) and defines `BottomBar` as a local function component. It pre-composes `Terminal + BottomBar` into a `terminalElement` and passes it **into** `FileTabs`.
- `FileTabs` owns the FileBrowser and `handleFileClick` (opens a file as a tab in the main content area), plus `SidePanel`.
- Problem: the Files panel needs `handleFileClick` (in `FileTabs`), but the Bottom Bar is assembled in `TerminalView`. They must meet.

### Change: extract BottomBar, let FileTabs inject the Files panel

1. **Extract `BottomBar` into its own file** `web/src/components/BottomBar.tsx` (moved verbatim from `TerminalView`, plus the changes below). This is a targeted improvement — `TerminalView` is already large and `BottomBar` is a self-contained unit with a clear contract.

2. **Widen the BottomBar contract** to support an optional third tab:
   - `activeTab: 'commands' | 'env' | 'files'`
   - `onTabChange: (tab: 'commands' | 'env' | 'files') => void`
   - add optional `filesPanel?: React.ReactNode` and `showFilesTab?: boolean` props. When `showFilesTab` is true, render the "Files" tab button (with a `Folder`/`FolderTree` lucide icon) and route `activeTab === 'files'` to `filesPanel`.

3. **Lift Bottom Bar state to `FileTabs`** OR **pass the composed BottomBar contract down.** Chosen approach: keep `bottomTab`/`sheetOpen` state in `TerminalView` (it already lives there and the desktop non-fileOps path uses it too), and pass `bottomTab`, `setBottomTab`, `sheetOpen`, `setSheetOpen`, `envPanel`, `commandsPanel` **into `FileTabs`** as props. `FileTabs` then renders `<BottomBar>` itself (in the fileOps branch) so it can supply `filesPanel={<FileBrowser ... onFileClick={handleFileClickAndCollapse} />}` and `showFilesTab={isMobile}`. The non-fileOps branch in `TerminalView` keeps rendering its own `<BottomBar>` with `showFilesTab={false}` (no file browser without fileOps).

   Rationale: `FileTabs` is where the FileBrowser + `handleFileClick` already live, so wiring the Files panel there needs no new bridge/callback plumbing back up to `TerminalView`.

4. **`isMobile`** via `useMediaQuery('(max-width: 1023px)')` (matches the `lg` breakpoint — `lg` is ≥1024px, so mobile is ≤1023px). Used in `FileTabs` to:
   - Gate `SidePanel` rendering: render `SidePanel` only when NOT mobile (`!isMobile`). On mobile, `SidePanel` is not in the tree at all.
   - Pass `showFilesTab={isMobile}` to `BottomBar`.

### Files touched
- **Create:** `web/src/components/BottomBar.tsx` — extracted + widened component.
- **Modify:** `web/src/components/TerminalView.tsx` — remove local `BottomBar`, import it; widen `bottomTab` state type; pass bottom-bar props + panels into `FileTabs`; keep the non-fileOps branch rendering `BottomBar` directly with `showFilesTab={false}`.
- **Modify:** `web/src/components/FileTabs.tsx` — accept bottom-bar props; compute `isMobile`; render `SidePanel` only on desktop; render `BottomBar` in the fileOps composition with `filesPanel` wired to a collapse-on-open handler.
- **Tests:** `web/src/components/__tests__/BottomBar.test.tsx` (new), extend `FileTabs.test.tsx`.

## 4. Behavior details

- **Full-height when Files active:** the Bottom Bar sheet is `max-h-[70dvh] sm:max-h-[40dvh]` today. When `activeTab === 'files'`, use a taller cap on mobile: `max-h-[85dvh]`. Implementation: the outer BottomBar div's max-height becomes conditional on `activeTab` — `activeTab === 'files' ? 'max-h-[85dvh] sm:max-h-[40dvh]' : 'max-h-[70dvh] sm:max-h-[40dvh]'`. (Desktop `sm:max-h-[40dvh]` unchanged; the Files tab is mobile-only so the `sm:` value is moot for it, but kept for class consistency.)
- **Open-a-file collapses the sheet:** in `FileTabs`, wrap `handleFileClick` so that after opening the file it calls `setSheetOpen(false)` (and leaves `activeTab` as-is). The file opens as a tab in the main content area (existing behavior) and the sheet collapses so the file is visible immediately.
- **Tab select opens the sheet:** existing `selectTab` behavior (tapping a tab sets it active AND opens the sheet) extends to `'files'`.
- **FileBrowser internals unchanged:** its header (breadcrumbs + New file/folder/Upload/Refresh) and listing already work in a `flex-1 min-h-0 overflow-y-auto` container. The action row stays pinned; the listing scrolls inside the 85dvh sheet. No change to `FileBrowser.tsx`.
- **Desktop unaffected:** at `lg:`+, `showFilesTab` is false, `SidePanel` renders as before, BottomBar shows 2 tabs.

## 5. Testing

**Unit/component (Vitest + Testing Library; jsdom can't evaluate media queries, so mock `matchMedia`):**
- **BottomBar:**
  - renders 2 tabs when `showFilesTab={false}`; 3 tabs (incl. "Files") when `showFilesTab={true}`.
  - `activeTab === 'files'` renders the `filesPanel` node; `'commands'`/`'env'` render their panels.
  - selecting the Files tab calls `onTabChange('files')` and opens the sheet (`onSheetToggle(true)`).
  - the outer container carries the taller max-height class (`max-h-[85dvh]`) when `activeTab === 'files'`, the `70dvh` class otherwise (class-presence assertion).
- **FileTabs:**
  - with `matchMedia` mocked to mobile, `SidePanel` is NOT rendered (assert its toggle button / testid absent) and the Bottom Bar "Files" tab IS present.
  - with `matchMedia` mocked to desktop, `SidePanel` IS rendered and `showFilesTab` is false (no Files tab).
  - clicking a file entry in the Files panel opens a file tab AND collapses the sheet (`sheetOpen` → false). (Reuse the existing FileTabs test harness / mock `FileOps`.)
  - existing FileTabs tests (terminal stays mounted, `onTerminalReveal`) still pass.

**Playwright MCP (mandatory per CLAUDE.md):** at 375px — open the terminal with a live session, tap the "Files" tab, confirm the panel is **opaque** (no terminal bleed-through), full-height, breadcrumbs+actions usable; tap a file, confirm the sheet collapses and the file opens as a tab. At 1440px — confirm the left `SidePanel` still works and there is no "Files" tab in the Bottom Bar. Screenshots to `.playwright-mcp/screenshots/`.

**Gates:** `npm run lint` (`--max-warnings 0`), `npx tsc --noEmit`, `npm test`, `npm run build`.

## 6. Delivery

Single PR, branch `feat/mobile-file-browser-tab`, body includes screenshots and links the mobile-layout work. No k8s/image changes (frontend-only).

## 7. Non-Goals

- No change to FileBrowser internals (tree, actions, context menu).
- No change to how files open/close/track dirty state.
- No change to desktop `SidePanel` (resizable left panel stays).
- No backend/WebSocket/protocol change.
- No new dependencies (`useMediaQuery` already exists on the base branch).
- Not touching Commands/Env panel behavior beyond the shared max-height conditional.

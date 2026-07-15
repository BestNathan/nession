# Mobile File Browser — Bottom Bar Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On mobile (<1024px), replace the semi-transparent left file-browser drawer with an opaque, full-height "Files" tab in the terminal Bottom Bar. Desktop unchanged.

**Architecture:** Extract `BottomBar` from `TerminalView` into its own file and widen it to an optional third "Files" tab. `FileTabs` computes `isMobile` via `useMediaQuery`, renders `SidePanel` desktop-only, and (in the fileOps path) renders `BottomBar` itself so it can inject a `filesPanel` (FileBrowser) wired to its existing open-file handler, collapsing the sheet on open.

**Tech Stack:** React 18, TypeScript, Tailwind v4, lucide-react, Vitest + Testing Library, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-07-14-mobile-file-browser-tab-design.md`
**Branch:** `feat/mobile-file-browser-tab` (already created, stacked on PR #53; spec committed).

---

## Conventions

- Run commands from `web/`. Verify branch before each commit: `git branch --show-current` must print `feat/mobile-file-browser-tab`.
- `useMediaQuery` (from `web/src/hooks/useMediaQuery.ts`, added on the base branch) returns `false` when `window.matchMedia` is undefined — so in jsdom without a mock, `isMobile` is `false` (desktop). Existing FileTabs tests rely on desktop behavior and must keep passing untouched.
- jsdom can't evaluate media queries or Tailwind; tests mock `matchMedia` and assert class/element presence.
- No `eslint-disable`; `--max-warnings 0`; strict TS; wrap handlers as `onClick={() => fn()}`.

---

## File Structure

- **Create:** `web/src/components/BottomBar.tsx` — extracted + widened `BottomBar`.
- **Create:** `web/src/components/__tests__/BottomBar.test.tsx`.
- **Modify:** `web/src/components/TerminalView.tsx` — remove local `BottomBar`, import it; widen `bottomTab` type; pass bottom-bar props + panels into `FileTabs`; non-fileOps branch renders `BottomBar` with `showFilesTab={false}`.
- **Modify:** `web/src/components/FileTabs.tsx` — accept bottom-bar props; `isMobile`; `SidePanel` desktop-only; render `BottomBar` with `filesPanel` + collapse-on-open.
- **Modify:** `web/src/components/__tests__/FileTabs.test.tsx` — add mobile/desktop cases; keep existing.

---

## Task 1: Extract BottomBar into its own file (no behavior change)

**Files:**
- Create: `web/src/components/BottomBar.tsx`
- Modify: `web/src/components/TerminalView.tsx`

- [ ] **Step 1: Create `web/src/components/BottomBar.tsx`** with the component moved verbatim from `TerminalView` (lines 177-248), adding the imports it needs. Exact content:

```tsx
import { TerminalIcon, Package, FolderTree, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BottomTab = 'commands' | 'env' | 'files';

interface BottomBarProps {
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  envPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
  /** Mobile-only Files tab content (FileBrowser). Rendered only when showFilesTab. */
  filesPanel?: React.ReactNode;
  /** Whether to show the Files tab (mobile only). */
  showFilesTab?: boolean;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
}

/** Bottom bar: tabbed Quick Commands / Env Files / (mobile) File browser. */
export function BottomBar({
  activeTab,
  onTabChange,
  envPanel,
  commandsPanel,
  filesPanel,
  showFilesTab = false,
  sheetOpen,
  onSheetToggle,
}: BottomBarProps) {
  // Mobile: tapping a tab both selects it and opens the sheet.
  const selectTab = (tab: BottomTab) => {
    onTabChange(tab);
    onSheetToggle(true);
  };

  // The Files browser needs more vertical room than the Commands grid / Env list.
  const maxH = activeTab === 'files' ? 'max-h-[85dvh] sm:max-h-[40dvh]' : 'max-h-[70dvh] sm:max-h-[40dvh]';

  return (
    <div className={cn('border-t flex-shrink-0 flex flex-col pb-[env(safe-area-inset-bottom)]', maxH)}>
      <div className="flex border-b items-center">
        <button
          type="button"
          onClick={() => selectTab('commands')}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
            activeTab === 'commands'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <TerminalIcon className="w-3 h-3" /> Commands
        </button>
        <button
          type="button"
          onClick={() => selectTab('env')}
          className={cn(
            'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
            activeTab === 'env'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <Package className="w-3 h-3" /> Env
        </button>
        {showFilesTab && (
          <button
            type="button"
            onClick={() => selectTab('files')}
            className={cn(
              'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
              activeTab === 'files'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <FolderTree className="w-3 h-3" /> Files
          </button>
        )}
        {/* Mobile-only sheet toggle: expand when collapsed, collapse when open. */}
        <button
          type="button"
          onClick={() => onSheetToggle(!sheetOpen)}
          className="ml-auto px-3 py-1 text-xs text-muted-foreground hover:text-foreground sm:hidden"
          title={sheetOpen ? 'Collapse' : 'Expand'}
        >
          {sheetOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
      </div>
      {/* Content: always shown at sm+; on mobile only when the sheet is open */}
      <div
        className={cn(
          'flex-1 min-h-0 overflow-y-auto',
          sheetOpen ? 'block' : 'hidden sm:block',
        )}
      >
        {activeTab === 'files' ? filesPanel : activeTab === 'env' ? envPanel : commandsPanel}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: In `TerminalView.tsx`, delete the local `BottomBar` function** (lines 175-248, including the `// ── Bottom bar …` comment) and its now-unused icon imports **only if unused elsewhere**. Check line 2 import: `TerminalIcon`, `Package`, `ChevronDown`, `ChevronUp` were used only by BottomBar — remove them from the `lucide-react` import in TerminalView IF grep shows no other use. Keep `ArrowLeft` (used by header). Add at the top: `import { BottomBar, type BottomTab } from './BottomBar';`

Verify which icons to drop:
```bash
cd /Users/admin/Documents/learn/nession/web && grep -n "TerminalIcon\|Package\|ChevronDown\|ChevronUp\|ArrowLeft" src/components/TerminalView.tsx
```
Remove from TerminalView's import only those that appear solely in the deleted BottomBar body.

- [ ] **Step 3: Widen the state type in `TerminalView.tsx`** — line 53:
```tsx
  const [bottomTab, setBottomTab] = useState<'commands' | 'env'>('commands');
```
→
```tsx
  const [bottomTab, setBottomTab] = useState<BottomTab>('commands');
```

- [ ] **Step 4: Typecheck + build to confirm the pure extraction is clean.**

Run: `npx tsc --noEmit && npm run build`
Expected: clean (the two `<BottomBar>` usages at former lines 136/155 still type-check — same prop names; `filesPanel`/`showFilesTab` are optional).

- [ ] **Step 5: Run the terminal-related tests** (no behavior change expected).

Run: `npm test -- TerminalView Terminal FileTabs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/BottomBar.tsx web/src/components/TerminalView.tsx
git commit -m "refactor(web): extract BottomBar into its own file, add optional Files tab

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: BottomBar unit tests

**Files:**
- Create: `web/src/components/__tests__/BottomBar.test.tsx`

- [ ] **Step 1: Write the tests.** Create `web/src/components/__tests__/BottomBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomBar } from '../BottomBar';

function setup(overrides: Partial<React.ComponentProps<typeof BottomBar>> = {}) {
  const props = {
    activeTab: 'commands' as const,
    onTabChange: vi.fn(),
    envPanel: <div data-testid="env-panel">ENV</div>,
    commandsPanel: <div data-testid="commands-panel">CMD</div>,
    filesPanel: <div data-testid="files-panel">FILES</div>,
    showFilesTab: false,
    sheetOpen: true,
    onSheetToggle: vi.fn(),
    ...overrides,
  };
  const utils = render(<BottomBar {...props} />);
  return { props, ...utils };
}

describe('BottomBar', () => {
  it('shows Commands and Env tabs but not Files when showFilesTab is false', () => {
    setup({ showFilesTab: false });
    expect(screen.getByRole('button', { name: /Commands/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Env/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull();
  });

  it('shows the Files tab when showFilesTab is true', () => {
    setup({ showFilesTab: true });
    expect(screen.getByRole('button', { name: /Files/ })).toBeInTheDocument();
  });

  it('renders the files panel when activeTab is files', () => {
    setup({ showFilesTab: true, activeTab: 'files' });
    expect(screen.getByTestId('files-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('commands-panel')).toBeNull();
  });

  it('renders commands panel by default', () => {
    setup({ activeTab: 'commands' });
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('files-panel')).toBeNull();
  });

  it('selecting the Files tab activates it and opens the sheet', () => {
    const { props } = setup({ showFilesTab: true, activeTab: 'commands' });
    fireEvent.click(screen.getByRole('button', { name: /Files/ }));
    expect(props.onTabChange).toHaveBeenCalledWith('files');
    expect(props.onSheetToggle).toHaveBeenCalledWith(true);
  });

  it('uses a taller max-height when the Files tab is active', () => {
    const { container } = setup({ showFilesTab: true, activeTab: 'files' });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-h-[85dvh]');
  });

  it('uses the standard max-height for commands/env', () => {
    const { container } = setup({ activeTab: 'commands' });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-h-[70dvh]');
    expect(root.className).not.toContain('max-h-[85dvh]');
  });
});
```

- [ ] **Step 2: Run tests.**

Run: `npm test -- BottomBar`
Expected: PASS (7 tests).

- [ ] **Step 3: Lint + typecheck.**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/__tests__/BottomBar.test.tsx
git commit -m "test(web): BottomBar tabs, files panel, and taller Files sheet

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Wire FileTabs — desktop-only SidePanel + mobile Files tab

**Files:**
- Modify: `web/src/components/FileTabs.tsx`
- Modify: `web/src/components/TerminalView.tsx`

- [ ] **Step 1: Update `TerminalView.tsx` to pass bottom-bar props + panels into `FileTabs`.**

The fileOps branch currently (former lines 129-151) composes `terminalElement` with `<BottomBar>` inside. Change it so `FileTabs` owns the BottomBar. Replace the fileOps `<FileTabs ...>` block:

```tsx
        {fileOps ? (
          <FileTabs
            fileOps={fileOps}
            onTerminalReveal={() => terminalRef.current?.refit()}
            bottomTab={bottomTab}
            onBottomTabChange={setBottomTab}
            sheetOpen={sheetOpen}
            onSheetToggle={setSheetOpen}
            envPanel={<EnvPanel wsService={wsService} sessionId={sessionId} />}
            commandsPanel={
              <TerminalToolbar
                sendText={(text) => terminalRef.current?.sendText(text)}
                disabled={toolbarDisabled}
              />
            }
            terminalElement={
              <div className="h-full min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
              </div>
            }
          />
        ) : (
```

Note: the `<BottomBar>` is removed from the fileOps `terminalElement` (FileTabs will render it). The non-fileOps branch (former lines 152-169) keeps its own `<BottomBar>` but add `showFilesTab={false}` explicitly for clarity:

```tsx
          <>
            <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
            <BottomBar
              activeTab={bottomTab}
              onTabChange={setBottomTab}
              showFilesTab={false}
              sheetOpen={sheetOpen}
              onSheetToggle={setSheetOpen}
              envPanel={<EnvPanel wsService={wsService} sessionId={sessionId} />}
              commandsPanel={
                <TerminalToolbar
                  sendText={(text) => terminalRef.current?.sendText(text)}
                  disabled={toolbarDisabled}
                />
              }
            />
          </>
        )}
```

- [ ] **Step 2: Update `FileTabs.tsx` — imports, props, isMobile, SidePanel gating, BottomBar rendering.**

(a) Add imports at the top:
```tsx
import { useMediaQuery } from '../hooks/useMediaQuery';
import { BottomBar, type BottomTab } from './BottomBar';
```

(b) Extend `FileTabsProps` (after `onTerminalReveal?`):
```tsx
  /** Bottom-bar wiring (lifted in TerminalView so the non-fileOps path shares it). */
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
  envPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
```

(c) Destructure the new props in the `FileTabs({ ... })` signature:
```tsx
export function FileTabs({
  fileOps, terminalElement, onTerminalReveal,
  bottomTab, onBottomTabChange, sheetOpen, onSheetToggle, envPanel, commandsPanel,
}: FileTabsProps) {
```

(d) Compute mobile + a collapse-on-open file handler. After the existing `handleFileClick` definition, add:
```tsx
  const isMobile = useMediaQuery('(max-width: 1023px)');

  // On mobile the browser lives in the Bottom Bar; opening a file collapses the
  // sheet so the freshly opened tab is visible.
  const handleFileClickMobile = useCallback((entry: FileEntry) => {
    handleFileClick(entry);
    onSheetToggle(false);
  }, [handleFileClick, onSheetToggle]);
```

(e) Replace the render `return (...)`. The current top-level layout is:
```tsx
    <div className="flex-1 min-h-0 flex flex-row">
      <SidePanel>
        <FileBrowser fileOps={fileOps} onFileClick={handleFileClick} onFileDeleted={handleFileDeleted} onFileRenamed={handleFileRenamed} />
      </SidePanel>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Tab bar */}
        <TabBar .../>
        {/* Content */}
        <div className="flex-1 min-h-0 relative">
          ...terminal + FileViewer...
        </div>
      </div>
    </div>
```
Replace with (SidePanel desktop-only; BottomBar appended below content; terminal/FileViewer content unchanged):
```tsx
    <div className="flex-1 min-h-0 flex flex-row">
      {!isMobile && (
        <SidePanel>
          <FileBrowser fileOps={fileOps} onFileClick={handleFileClick} onFileDeleted={handleFileDeleted} onFileRenamed={handleFileRenamed} />
        </SidePanel>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Tab bar */}
        <TabBar
          openFiles={openFiles}
          activeTabId={activeTabId}
          dirtyFiles={dirtyFiles}
          showTerminal={showTerminal}
          onSelect={setActiveTabId}
          onClose={handleCloseFile}
        />

        {/* Content */}
        <div className="flex-1 min-h-0 relative">
          <div className={cn('absolute inset-0', !showTerminal && 'hidden')}>
            {terminalElement}
          </div>
          {!showTerminal && activeFile ? (
            <div className="absolute inset-0">
              <FileViewer key={activeFile.id} fileOps={fileOps} path={activeFile.path} filename={activeFile.filename} onClose={() => handleCloseFile(activeFile.id)} onDirtyChange={(dirty) => handleDirtyChange(activeFile.id, dirty)} />
            </div>
          ) : null}
        </div>

        <BottomBar
          activeTab={bottomTab}
          onTabChange={onBottomTabChange}
          showFilesTab={isMobile}
          sheetOpen={sheetOpen}
          onSheetToggle={onSheetToggle}
          envPanel={envPanel}
          commandsPanel={commandsPanel}
          filesPanel={
            <FileBrowser fileOps={fileOps} onFileClick={handleFileClickMobile} onFileDeleted={handleFileDeleted} onFileRenamed={handleFileRenamed} />
          }
        />
      </div>
    </div>
```

- [ ] **Step 3: Typecheck + build.**

Run: `npx tsc --noEmit && npm run build`
Expected: clean. (If `useCallback` is not yet imported in FileTabs — it is, per line 1 — confirm.)

- [ ] **Step 4: Run existing FileTabs + Terminal tests (desktop path, matchMedia undefined → isMobile false).**

Run: `npm test -- FileTabs TerminalView Terminal`
Expected: PASS — existing FileTabs tests still open the SidePanel via "Open panel" (desktop path unchanged since jsdom `matchMedia` is undefined → `isMobile=false`).

- [ ] **Step 5: Lint.**

Run: `npm run lint`
Expected: 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/FileTabs.tsx web/src/components/TerminalView.tsx
git commit -m "feat(web): mobile file browser as Bottom Bar Files tab, desktop SidePanel only

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: FileTabs mobile/desktop behavior tests

**Files:**
- Modify: `web/src/components/__tests__/FileTabs.test.tsx`

- [ ] **Step 1: Add a matchMedia mock helper + mobile/desktop cases.** The existing tests render `FileTabs` with only `fileOps`/`terminalElement`/`onTerminalReveal` — but the component now requires the bottom-bar props. **Update the existing two tests' render calls** to include the new required props, and add new cases. Replace the whole `describe('FileTabs', ...)` body's setup so a shared `renderFileTabs` helper supplies the bottom-bar props.

First, add a `matchMedia` mock helper near the top of the file (after imports):
```tsx
function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

const bottomBarProps = {
  bottomTab: 'commands' as const,
  onBottomTabChange: vi.fn(),
  sheetOpen: true,
  onSheetToggle: vi.fn(),
  envPanel: <div data-testid="env-panel">ENV</div>,
  commandsPanel: <div data-testid="commands-panel">CMD</div>,
};
```

Update `beforeEach` to also reset globals:
```tsx
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
```

Update the two EXISTING tests' `render(<FileTabs .../>)` calls to spread `{...bottomBarProps}` alongside their current props (both tests rely on the desktop SidePanel "Open panel" button, which requires `isMobile=false`; with `matchMedia` unstubbed, `useMediaQuery` returns false → desktop → SidePanel present, so they keep working — but add `mockMatchMedia(false)` as the first line of each to be explicit and robust).

- [ ] **Step 2: Add the new cases** inside the `describe`:

```tsx
  it('on desktop renders the SidePanel and no Files tab', () => {
    mockMatchMedia(false);
    render(
      <FileTabs
        fileOps={makeFileOps([FILE])}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
      />,
    );
    // SidePanel toggle present (desktop)
    expect(screen.getByTitle('Open panel')).toBeInTheDocument();
    // No Files tab in the bottom bar
    expect(screen.queryByRole('button', { name: /Files/ })).toBeNull();
  });

  it('on mobile hides the SidePanel and shows a Files tab', () => {
    mockMatchMedia(true);
    render(
      <FileTabs
        fileOps={makeFileOps([FILE])}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
      />,
    );
    // SidePanel toggle absent (mobile)
    expect(screen.queryByTitle('Open panel')).toBeNull();
    // Files tab present in the bottom bar
    expect(screen.getByRole('button', { name: /Files/ })).toBeInTheDocument();
  });

  it('on mobile, opening a file from the Files panel collapses the sheet', async () => {
    mockMatchMedia(true);
    const onSheetToggle = vi.fn();
    render(
      <FileTabs
        fileOps={makeFileOps([FILE])}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
        sheetOpen={true}
        onSheetToggle={onSheetToggle}
      />,
    );
    // The Files panel FileBrowser lists the file (sheet is open, files tab content shown).
    // Activate the Files tab first so its panel is the visible content.
    fireEvent.click(screen.getByRole('button', { name: /Files/ }));
    const fileButton = await screen.findByText('f.txt');
    fireEvent.click(fileButton);
    // Opening the file collapses the sheet.
    await waitFor(() => expect(onSheetToggle).toHaveBeenCalledWith(false));
  });
```

NOTE on the third test: `bottomTab` is `'commands'` in `bottomBarProps`, so the Files panel isn't the rendered content until the Files tab is clicked — but clicking it only calls `onBottomTabChange` (a mock; state doesn't actually change since the parent is a mock). The FileBrowser inside `filesPanel` is always mounted regardless of active tab (the BottomBar renders `filesPanel` only when `activeTab === 'files'`). Therefore, to make `f.txt` findable, pass `bottomTab="files"` for THIS test so the files panel is the active content:

Replace the third test's props to include `bottomTab={'files' as const}` overriding the spread:
```tsx
      <FileTabs
        fileOps={makeFileOps([FILE])}
        terminalElement={<div data-testid="terminal-marker">TERMINAL</div>}
        {...bottomBarProps}
        bottomTab={'files'}
        sheetOpen={true}
        onSheetToggle={onSheetToggle}
      />,
```
and REMOVE the `fireEvent.click(screen.getByRole('button', { name: /Files/ }))` line (not needed — files panel already active). The file `f.txt` is then rendered by the FileBrowser in the files panel; clicking it triggers `handleFileClickMobile` → `onSheetToggle(false)`.

- [ ] **Step 3: Run FileTabs tests.**

Run: `npm test -- FileTabs`
Expected: PASS (2 existing updated + 3 new = 5).

- [ ] **Step 4: Lint + typecheck.**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/__tests__/FileTabs.test.tsx
git commit -m "test(web): FileTabs mobile Files tab / desktop SidePanel + collapse-on-open

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Full gate

- [ ] **Step 1: Full suite + coverage.**

Run: `npm test -- --run && npm run coverage`
Expected: all PASS; coverage ≥80% (project threshold).

- [ ] **Step 2: Lint + typecheck + build.**

Run: `npm run lint && npx tsc --noEmit && npm run build`
Expected: 0 warnings, no type errors, build succeeds.

- [ ] **Step 3: If anything fails, fix and re-run before proceeding. Commit fixes with a `fix:` message.**

---

## Task 6: Playwright verification

Run the demo stack per CLAUDE.md (isolated HOME on ports the vite proxy expects — server config `listen_address = "127.0.0.1:19090"`, agent `listen/connect 19091`, `auth_token=""`):
```bash
# (See prior session pattern) start server from a dir containing config.toml pinning 19090,
# start agent with a local agent-config.toml, create a tmux session, start vite on :13000.
```
Log in at `http://localhost:13000` (any non-empty token; `localStorage.clear()` first). Attach a session with Canvas renderer.

- [ ] **Step 1: Mobile (375px) — Files tab is opaque + full-height.** Resize to 375×667. In the terminal view, tap the **Files** tab in the Bottom Bar. Screenshot `.playwright-mcp/screenshots/files-tab-375.png`. Verify via `browser_evaluate`: the bottom-bar content has a solid (non-transparent) computed `background-color` and there is NO `sidepanel-backdrop` element; assert no `[data-testid="sidepanel-backdrop"]` and no "Open panel" title button exist.

- [ ] **Step 2: Mobile — open a file collapses the sheet.** With the Files tab open and a file listed, tap a file. Confirm the file opens as a tab in the main area and the sheet collapses (the Files listing is hidden; terminal/file content visible). Screenshot `files-tab-375-opened.png`.

- [ ] **Step 3: Mobile — no horizontal overflow.** `browser_evaluate`: `document.scrollingElement.scrollWidth <= clientWidth` at 375px. Expected true.

- [ ] **Step 4: Desktop (1440px) — SidePanel unchanged, no Files tab.** Resize to 1440×900. Confirm the left SidePanel toggle ("Open panel"/"Close panel") is present and opens the resizable file browser; confirm the Bottom Bar has only Commands / Env (no Files tab). Screenshots `sidepanel-1440.png`, `bottombar-1440.png`.

- [ ] **Step 5: Tear down** the demo stack (`tmux kill-server`; `pkill` server/agent/vite).

- [ ] **Step 6: Commit any verification-driven fixes** (otherwise no commit).

---

## Task 7: Open PR

- [ ] **Step 1: Push.** `git branch --show-current` (expect `feat/mobile-file-browser-tab`), then `git push -u origin feat/mobile-file-browser-tab`.

- [ ] **Step 2: Create the PR** with `gh pr create`, title `feat: mobile file browser as Bottom Bar Files tab`, body summarizing: the transparent left drawer replaced by an opaque full-height Files tab on mobile; desktop SidePanel unchanged; BottomBar extracted; tests + Playwright screenshots (375 + 1440). Note it stacks on PR #53 (base branch `feat/webui-responsive-layout`) — set `--base feat/webui-responsive-layout` if #53 is unmerged at PR time, else `--base main` after #53 merges. Include `.playwright-mcp/screenshots/*` references under 核心功能截图.

---

## Self-Review Notes

Spec coverage: §3 architecture → Tasks 1+3 ✅ | extract BottomBar → Task 1 ✅ | widen contract (3rd tab, filesPanel, showFilesTab) → Task 1 ✅ | isMobile + SidePanel desktop-only → Task 3 ✅ | full-height Files (85dvh) → Task 1 (BottomBar maxH) + Task 2 test ✅ | collapse-on-open → Task 3 (handleFileClickMobile) + Task 4 test ✅ | FileBrowser unchanged → confirmed (only its parent placement changes) ✅ | §5 tests → Tasks 2, 4 (unit) + 5 (gate) + 6 (Playwright) ✅ | §6 delivery → Task 7 ✅

Type/name consistency: `BottomTab` type defined in `BottomBar.tsx` (Task 1), imported by `TerminalView` (Task 1) and `FileTabs` (Task 3). `showFilesTab`/`filesPanel` optional props consistent across Tasks 1-3. `handleFileClickMobile` defined in FileTabs Task 3, asserted in Task 4. matchMedia-undefined→desktop invariant protects existing tests (Task 3 Step 4 / Task 4).

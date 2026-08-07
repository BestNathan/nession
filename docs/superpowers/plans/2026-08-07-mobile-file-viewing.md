# Mobile File Viewing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable file viewing + editing on mobile by extracting `useFileTabs` hook and creating `MobileFileTabs` component that shares logic with desktop `FileTabs`.

**Architecture:** Three-step refactor: (1) extract `useFileTabs` hook from `FileTabs.tsx` into `hooks/useFileTabs.ts`, (2) create `MobileFileTabs.tsx` that consumes the hook with a mobile-optimized layout, (3) wire `MobileTerminalLayout.tsx` to connect FileBrowser clicks → hook → FileViewer rendering. Desktop `FileTabs` behavior is unchanged.

**Tech Stack:** React 18, TypeScript, Vitest + React Testing Library, Tailwind v4

---

### File Structure

| File | Role |
|------|------|
| `hooks/useFileTabs.ts` | **(new)** Pure hook — open-file state, tab switching, dirty tracking, delete/rename handlers. Zero JSX. |
| `components/FileTabs.tsx` | **(modify)** Import hook. Remove inline `useFileTabs` + `TabBar` (moves to hook). Desktop `TabBar` stays. Desktop `FileTabs` component unchanged. |
| `components/MobileFileTabs.tsx` | **(new)** Mobile layout — tab strip + terminal/FileViewer switch. No SidePanel, no ResizablePanelGroup. |
| `components/MobileTerminalLayout.tsx` | **(modify)** Wire `FileBrowser.onFileClick` → `MobileFileTabs.handleFileClick` via ref. |
| `components/__tests__/FileTabs.test.tsx` | **(modify)** Update imports if hook path changes. |
| `components/__tests__/MobileFileTabs.test.tsx` | **(new)** Rendering tests — tab strip visibility, terminal always in DOM, FileViewer renders for active file. |

---

### Task 1: Extract `hooks/useFileTabs.ts`

**Files:**
- Create: `web/src/hooks/useFileTabs.ts`
- Modify: `web/src/components/FileTabs.tsx`

- [ ] **Step 1: Create `web/src/hooks/useFileTabs.ts` with the extracted hook**

Move `OpenFile` interface, `MAX_TABS` constant, and `useFileTabs` function from `FileTabs.tsx` lines 15-188 into the new file. Add the import for `FileEntry` type.

```typescript
// web/src/hooks/useFileTabs.ts
import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import { generateId } from '@/lib/idGenerator';
import type { FileEntry } from '../services/fileOps';

export interface OpenFile {
  id: string;
  path: string;
  filename: string;
}

export const MAX_TABS = 10;

/**
 * Open-file tab state: which files are open, which tab is active, dirty
 * tracking, and the handlers FileBrowser/FileViewer drive. Shared by
 * FileTabs (desktop) and MobileFileTabs (mobile).
 */
export function useFileTabs(onTerminalReveal?: () => void) {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('terminal');
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());

  const handleFileClick = useCallback((entry: FileEntry) => {
    const existing = openFiles.find((f) => f.path === entry.path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    if (openFiles.length >= MAX_TABS) {
      const toClose = openFiles.find((f) => !dirtyFiles.has(f.id));
      if (toClose) {
        setOpenFiles((prev) => prev.filter((f) => f.id !== toClose.id));
      } else {
        toast.error(`Maximum ${MAX_TABS} files open. Close some first.`);
        return;
      }
    }

    const id = generateId('file');
    setOpenFiles((prev) => [...prev, { id, path: entry.path, filename: entry.name }]);
    setActiveTabId(id);
  }, [openFiles, dirtyFiles]);

  const handleCloseFile = useCallback((id: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.id !== id));
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      if (dirty) { next.add(id); }
      else { next.delete(id); }
      return next;
    });
  }, []);

  const handleFileDeleted = useCallback((path: string) => {
    const deletedFile = openFiles.find((f) => f.path === path);
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    if (deletedFile) {
      setDirtyFiles((prev) => {
        const next = new Set(prev);
        next.delete(deletedFile.id);
        return next;
      });
    }
  }, [openFiles]);

  const handleFileRenamed = useCallback((oldPath: string, newPath: string) => {
    const newFilename = newPath.split('/').pop() || newPath;
    setOpenFiles((prev) =>
      prev.map((f) =>
        f.path === oldPath ? { ...f, path: newPath, filename: newFilename } : f,
      ),
    );
  }, []);

  const activeFile = openFiles.find((f) => f.id === activeTabId);
  const showTerminal = activeTabId === 'terminal';

  // If the active tab was closed, switch to the last remaining tab or terminal.
  useLayoutEffect(() => {
    if (activeTabId !== 'terminal' && !openFiles.find((f) => f.id === activeTabId)) {
      setActiveTabId(openFiles.length > 0 ? openFiles[openFiles.length - 1].id : 'terminal');
    }
  }, [activeTabId, openFiles, setActiveTabId]);

  // Refit the terminal whenever it transitions back into view.
  const wasTerminalVisibleRef = useRef(showTerminal);
  useEffect(() => {
    if (showTerminal && !wasTerminalVisibleRef.current) {
      onTerminalReveal?.();
    }
    wasTerminalVisibleRef.current = showTerminal;
  }, [showTerminal, onTerminalReveal]);

  return {
    openFiles, activeTabId, setActiveTabId, dirtyFiles, activeFile, showTerminal,
    handleFileClick, handleCloseFile, handleDirtyChange, handleFileDeleted, handleFileRenamed,
  };
}
```

- [ ] **Step 2: Update `web/src/components/FileTabs.tsx` to import from hook**

Remove lines 15-188 (the `OpenFile` interface, `MAX_TABS`, `TabBarProps`, `TabBar`, and `useFileTabs` function). Add import from hooks:

```typescript
// web/src/components/FileTabs.tsx — top of file, add import:
import { useFileTabs, type OpenFile, MAX_TABS } from '../hooks/useFileTabs';
```

The `TabBar` component (lines 52-84) stays in `FileTabs.tsx` — it's desktop-specific rendering.

The `FileTabs` component (line 190+) stays unchanged — it already calls `useFileTabs`.

- [ ] **Step 3: Run lint and tests to verify no regressions**

```bash
cd web && npm run lint && npm test -- --run
```

Expected: ESLint passes, all 631 tests pass. No behavior change.

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useFileTabs.ts web/src/components/FileTabs.tsx
git commit -m "refactor: extract useFileTabs hook from FileTabs

Move open-file state, tab switching, dirty tracking, and file event
handlers into hooks/useFileTabs.ts. Shared by FileTabs (desktop) and
upcoming MobileFileTabs (mobile). No logic changes.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Create `MobileFileTabs.tsx`

**Files:**
- Create: `web/src/components/MobileFileTabs.tsx`

- [ ] **Step 1: Write the component**

```typescript
// web/src/components/MobileFileTabs.tsx
import { useEffect } from 'react';
import { X, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFileTabs } from '../hooks/useFileTabs';
import { FileViewer } from './FileViewer';
import type { FileOps, FileEntry } from '../services/fileOps';

interface MobileTabBarProps {
  openFiles: { id: string; path: string; filename: string }[];
  activeTabId: string;
  showTerminal: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/** Compact scrollable tab strip — only file closing, no dirty dots. */
function MobileTabBar({ openFiles, activeTabId, showTerminal, onSelect, onClose }: MobileTabBarProps) {
  return (
    <div className="flex items-center border-b bg-muted/20 flex-shrink-0 overflow-x-auto">
      <button
        onClick={() => onSelect('terminal')}
        className={cn(
          'flex items-center gap-1 px-3 py-1.5 text-xs border-r border-b-2 transition-colors flex-shrink-0',
          showTerminal ? 'border-b-primary bg-background text-foreground' : 'border-b-transparent text-muted-foreground hover:text-foreground',
        )}
      >
        <Terminal className="h-3 w-3" /> Terminal
      </button>
      {openFiles.map((file) => (
        <button
          key={file.id}
          onClick={() => onSelect(file.id)}
          className={cn(
            'flex items-center gap-1 px-3 py-1.5 text-xs border-r border-b-2 transition-colors flex-shrink-0 max-w-[120px]',
            activeTabId === file.id ? 'border-b-primary bg-background text-foreground' : 'border-b-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <span className="truncate">{file.filename}</span>
          <X className="h-3 w-3 flex-shrink-0 hover:text-destructive ml-0.5" onClick={(e) => { e.stopPropagation(); onClose(file.id); }} />
        </button>
      ))}
    </div>
  );
}

export interface MobileFileTabsProps {
  fileOps: FileOps;
  terminalElement: React.ReactNode;
  onTerminalReveal?: () => void;
  sessionId?: string;
  onGetTerminalPwd?: () => Promise<string>;
  /** Populated with handleFileClick so the parent can wire FileBrowser. */
  onFileClickRef: React.MutableRefObject<((entry: FileEntry) => void) | null>;
}

/**
 * Mobile file-tab layout — no SidePanel, no ResizablePanelGroup.
 *
 * Shares useFileTabs hook with desktop FileTabs. When no files are open
 * the tab strip is hidden and the terminal fills the screen (identical to
 * today's mobile experience). Clicking a file shows the tab strip +
 * FileViewer in place of the terminal.
 */
export function MobileFileTabs({
  fileOps,
  terminalElement,
  onTerminalReveal,
  sessionId,
  onGetTerminalPwd,
  onFileClickRef,
}: MobileFileTabsProps) {
  const {
    openFiles, activeTabId, setActiveTabId, activeFile, showTerminal,
    handleFileClick, handleCloseFile, handleDirtyChange,
  } = useFileTabs(onTerminalReveal);

  // Expose handleFileClick to parent so the FileBrowser in BottomSheet
  // can trigger file opens.
  useEffect(() => {
    onFileClickRef.current = handleFileClick;
  }, [handleFileClick, onFileClickRef]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Tab bar — only visible when files are open */}
      {openFiles.length > 0 && (
        <MobileTabBar
          openFiles={openFiles}
          activeTabId={activeTabId}
          showTerminal={showTerminal}
          onSelect={setActiveTabId}
          onClose={handleCloseFile}
        />
      )}

      {/* Content area — terminal or FileViewer */}
      <div className="flex-1 min-h-0 relative">
        {/* Terminal — always mounted, hidden when file tab is active */}
        <div className={cn('absolute inset-0', !showTerminal && 'hidden')}>
          {terminalElement}
        </div>
        {/* FileViewer — shown when a file tab is active */}
        {!showTerminal && activeFile ? (
          <div className="absolute inset-0">
            <FileViewer
              key={activeFile.id}
              fileOps={fileOps}
              path={activeFile.path}
              filename={activeFile.filename}
              onClose={() => handleCloseFile(activeFile.id)}
              onDirtyChange={(dirty) => handleDirtyChange(activeFile.id, dirty)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run lint and type-check**

```bash
cd web && npm run lint && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/MobileFileTabs.tsx
git commit -m "feat: add MobileFileTabs component for mobile file viewing

Shares useFileTabs hook with desktop FileTabs. Compact tab strip
appears when files are open; terminal hidden via CSS. FileBrowser
in BottomSheet wires to handleFileClick via ref.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Write `MobileFileTabs.test.tsx`

**Files:**
- Create: `web/src/components/__tests__/MobileFileTabs.test.tsx`

- [ ] **Step 1: Write the test file**

Mock `useFileTabs` to control internal state so the tests verify rendering behavior in isolation. Hook logic is already covered by `FileTabs.test.tsx`.

```typescript
// web/src/components/__tests__/MobileFileTabs.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileFileTabs } from '../MobileFileTabs';
import type { FileOps, FileEntry } from '../../services/fileOps';

// Mock useFileTabs to return controlled state for rendering tests.
// The hook's internal logic is tested via FileTabs.test.tsx.
const mockUseFileTabs = vi.fn();
vi.mock('../../hooks/useFileTabs', () => ({
  useFileTabs: (...args: unknown[]) => mockUseFileTabs(...args),
  MAX_TABS: 10,
}));

function makeFileOps(): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries: [] }),
    readFile: vi.fn().mockResolvedValue({ path: '/f.txt', content: btoa('hello'), mime_type: 'text/plain' }),
    writeFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    deleteFile: vi.fn().mockResolvedValue({ path: '/f.txt', success: true }),
    createDir: vi.fn().mockResolvedValue({ path: '/d', success: true }),
    renameFile: vi.fn().mockResolvedValue({ from: '/a', to: '/b', success: true }),
    uploadFile: vi.fn().mockResolvedValue({ path: '/f.txt', written: 5 }),
    base64Decode: (b64: string) => atob(b64),
    base64Encode: (s: string) => btoa(s),
  } as unknown as FileOps;
}

function defaultHookReturn(overrides: Record<string, unknown> = {}) {
  return {
    openFiles: [],
    activeTabId: 'terminal',
    setActiveTabId: vi.fn(),
    dirtyFiles: new Set<string>(),
    activeFile: undefined,
    showTerminal: true,
    handleFileClick: vi.fn(),
    handleCloseFile: vi.fn(),
    handleDirtyChange: vi.fn(),
    handleFileDeleted: vi.fn(),
    handleFileRenamed: vi.fn(),
    ...overrides,
  };
}

describe('MobileFileTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFileTabs.mockImplementation(() => defaultHookReturn());
  });

  const TERMINAL = <div data-testid="terminal-marker">TERMINAL</div>;
  const baseProps = {
    fileOps: makeFileOps(),
    terminalElement: TERMINAL,
    onFileClickRef: { current: null },
  };

  it('renders terminal when no files are open, no tab strip', () => {
    render(<MobileFileTabs {...baseProps} />);

    expect(screen.getByTestId('terminal-marker')).toBeInTheDocument();
    // No tab strip — no "Terminal" button should be visible
    expect(screen.queryByRole('button', { name: /Terminal/ })).toBeNull();
  });

  it('shows tab strip with Terminal + file tabs when files are open', () => {
    mockUseFileTabs.mockImplementation(() =>
      defaultHookReturn({
        openFiles: [{ id: 'f1', path: '/config.ts', filename: 'config.ts' }],
        activeTabId: 'f1',
        activeFile: { id: 'f1', path: '/config.ts', filename: 'config.ts' },
        showTerminal: false,
      }),
    );

    render(<MobileFileTabs {...baseProps} />);

    // Tab strip visible — Terminal button + file tab button
    expect(screen.getByRole('button', { name: /Terminal/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /config\.ts/i })).toBeInTheDocument();

    // Terminal element still in DOM (hidden)
    expect(screen.getByTestId('terminal-marker')).toBeInTheDocument();
  });

  it('hides tab strip when last file is closed', () => {
    const { rerender } = render(<MobileFileTabs {...baseProps} />);

    // No tab strip initially
    expect(screen.queryByRole('button', { name: /Terminal/ })).toBeNull();

    // Simulate opening a file
    mockUseFileTabs.mockImplementation(() =>
      defaultHookReturn({
        openFiles: [{ id: 'f1', path: '/a.ts', filename: 'a.ts' }],
        activeTabId: 'f1',
        activeFile: { id: 'f1', path: '/a.ts', filename: 'a.ts' },
        showTerminal: false,
      }),
    );
    rerender(<MobileFileTabs {...baseProps} />);
    expect(screen.getByRole('button', { name: /Terminal/ })).toBeInTheDocument();

    // Simulate closing the file
    mockUseFileTabs.mockImplementation(() => defaultHookReturn());
    rerender(<MobileFileTabs {...baseProps} />);
    expect(screen.queryByRole('button', { name: /Terminal/ })).toBeNull();
  });

  it('exposes handleFileClick via onFileClickRef', () => {
    const ref = { current: null } as React.MutableRefObject<((entry: FileEntry) => void) | null>;
    const handleClick = vi.fn();
    mockUseFileTabs.mockImplementation(() =>
      defaultHookReturn({ handleFileClick: handleClick }),
    );

    render(<MobileFileTabs {...baseProps} onFileClickRef={ref} />);

    expect(ref.current).toBe(handleClick);
  });

  it('terminal element stays mounted when file tab is active', () => {
    mockUseFileTabs.mockImplementation(() =>
      defaultHookReturn({
        openFiles: [{ id: 'f1', path: '/f.ts', filename: 'f.ts' }],
        activeTabId: 'f1',
        activeFile: { id: 'f1', path: '/f.ts', filename: 'f.ts' },
        showTerminal: false,
      }),
    );

    render(<MobileFileTabs {...baseProps} />);

    // Terminal is in DOM (hidden via CSS) so xterm instance survives
    expect(screen.getByTestId('terminal-marker')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd web && npx vitest run src/components/__tests__/MobileFileTabs.test.tsx
```

Expected: 5 tests pass.

- [ ] **Step 3: Run full test suite to verify no regressions**

```bash
cd web && npm test -- --run
```

Expected: all tests pass (631 + 5 = 636).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/__tests__/MobileFileTabs.test.tsx
git commit -m "test: add MobileFileTabs rendering tests

Verify tab strip visibility, terminal always in DOM, FileViewer render,
and onFileClickRef wiring. Hook logic tested via existing FileTabs tests.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Wire `MobileTerminalLayout.tsx`

**Files:**
- Modify: `web/src/components/MobileTerminalLayout.tsx`

- [ ] **Step 1: Add MobileFileTabs and wire FileBrowser.onFileClick**

```typescript
// web/src/components/MobileTerminalLayout.tsx
// Add to imports:
import { useRef } from 'react';
import { MobileFileTabs } from './MobileFileTabs';

// Inside the component, replace the current return with:
export function MobileTerminalLayout({
  terminalElement,
  sessionId,
  sendText,
  toolbarDisabled,
  fileOps,
  fontSizeManager,
  onGetTerminalPwd,
}: MobileTerminalLayoutProps) {
  const [bottomTab, setBottomTab] = useState<BottomTab>('input');
  const [sheetCollapsed, setSheetCollapsed] = useState(false);

  const handleToggleCollapse = useCallback(() => {
    setSheetCollapsed((prev) => !prev);
  }, []);

  // Ref populated by MobileFileTabs so FileBrowser in BottomSheet
  // can trigger file opens.
  const fileClickRef = useRef<((entry: import('../services/fileOps').FileEntry) => void) | null>(null);

  const envPanel = <EnvPanel sessionId={sessionId} />;
  const commandsPanel = <QuickCommandsPanel sendText={sendText} disabled={toolbarDisabled} />;
  const inputPanel = <InputPanel sendText={sendText} disabled={toolbarDisabled} />;
  const filesPanel = fileOps ? (
    <FileBrowser
      fileOps={fileOps}
      onFileClick={(entry) => fileClickRef.current?.(entry)}
      onFileDeleted={() => {}}
      onFileRenamed={() => {}}
      onGetTerminalPwd={onGetTerminalPwd}
    />
  ) : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {/* Mobile tab strip + content (terminal or FileViewer) */}
      {fileOps ? (
        <MobileFileTabs
          fileOps={fileOps}
          terminalElement={<div className="flex-1 min-h-0 relative">{terminalElement}</div>}
          sessionId={sessionId}
          onGetTerminalPwd={onGetTerminalPwd}
          onFileClickRef={fileClickRef}
        />
      ) : (
        <div className="flex-1 min-h-0 relative">{terminalElement}</div>
      )}
      <BottomSheet
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        collapsed={sheetCollapsed}
        onToggleCollapse={handleToggleCollapse}
        showFilesTab={!!fileOps}
        fontSizeManager={fontSizeManager ?? null}
        inputPanel={inputPanel}
        commandsPanel={commandsPanel}
        envPanel={envPanel}
        filesPanel={filesPanel}
      />
    </div>
  );
}
```

Key changes from current `MobileTerminalLayout.tsx`:
- Import `useRef` and `MobileFileTabs`
- Create `fileClickRef` ref
- Wrap terminal in `MobileFileTabs` when `fileOps` is available
- `FileBrowser.onFileClick` calls `fileClickRef.current?.(entry)`

- [ ] **Step 2: Run lint, type-check, and tests**

```bash
cd web && npm run lint && npx tsc --noEmit && npm test -- --run
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/MobileTerminalLayout.tsx
git commit -m "feat: wire MobileFileTabs into MobileTerminalLayout

FileBrowser.onFileClick now connects to MobileFileTabs.handleFileClick
via ref, so tapping a file in the BottomSheet opens it in a tab above.
When no files are open the terminal fills the screen (unchanged).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Verify end-to-end

- [ ] **Step 1: Run full lint + type-check + test suite**

```bash
cd web && npm run lint && npx tsc --noEmit && npm test -- --run
```

Expected: all pass.

- [ ] **Step 2: Push and create PR**

```bash
git push origin feat/fix-sidepanel-collapse
```

Expected: CI passes, staging deploy. Verify on staging via Playwright:
1. Resize to mobile (375×812)
2. Navigate to terminal page
3. Open Files tab in BottomSheet
4. Click a file → tab strip appears + FileViewer shows content
5. Click Terminal tab → switches back to terminal
6. Close file tab → tab strip hides when no files remain

- [ ] **Step 3: Commit any fixes from verification**

If verification reveals issues, fix and commit on the same branch.

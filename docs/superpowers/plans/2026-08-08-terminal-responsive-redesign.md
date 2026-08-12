# Terminal Responsive Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign terminal layout with shadcn/ui components, swipe-based mobile navigation (Terminal/Files/Envs), and CSS-driven responsive switching.

**Architecture:** Mobile gets a SwipeableViewport with 3 panels (Terminal + CollapsibleInputBar, Files with internal nav stack, Envs). Desktop keeps side-by-side ResizablePanelGroup with TabBar converted to shadcn Tabs. Both layouts always mounted, visibility toggled via CSS `hidden`.

**Tech Stack:** React 18, TypeScript, Tailwind v4, shadcn/ui, xterm.js 5.5

---

## File Structure

```
web/src/components/
├── SwipeableViewport.tsx     [NEW]     Touch swipe + CSS transform panel switcher
├── BottomNavIndicator.tsx    [NEW]     Three-dot indicator, visual only
├── MobileTerminalLayout.tsx  [REWRITE] SwipeableViewport + 3 panels + CollapsibleInputBar
├── TerminalLayout.tsx        [MODIFY]  CSS-driven dual-mount, remove BottomSheet wiring
├── FileTabs.tsx              [MODIFY]  Replace hand-rolled TabBar with shadcn Tabs
├── BottomSheet.tsx           [DELETE]  Replaced by CollapsibleInputBar
└── MobileFileTabs.tsx        [DELETE]  Absorbed into new MobileTerminalLayout
```

---

### Task 1: Create BottomNavIndicator

**Files:**
- Create: `web/src/components/BottomNavIndicator.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { cn } from '@/lib/utils';

interface BottomNavIndicatorProps {
  count: number;
  activeIndex: number;
}

/**
 * Visual-only dot indicator for the current panel in SwipeableViewport.
 * Non-interactive — swipe is the primary navigation method.
 */
export function BottomNavIndicator({ count, activeIndex }: BottomNavIndicatorProps) {
  return (
    <div
      className="flex items-center justify-center gap-1.5 py-2"
      role="tablist"
      aria-label="Navigation panels"
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          role="tab"
          aria-selected={i === activeIndex}
          aria-label={`Panel ${i + 1}`}
          className={cn(
            'size-2 rounded-full transition-colors duration-200',
            i === activeIndex ? 'bg-primary' : 'bg-muted',
          )}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit src/components/BottomNavIndicator.tsx
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/BottomNavIndicator.tsx
git commit -m "feat: add BottomNavIndicator dot indicator component

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Create SwipeableViewport

**Files:**
- Create: `web/src/components/SwipeableViewport.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useState, useRef, useCallback, type TouchEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SwipeableViewportProps {
  children: ReactNode[];
  activeIndex: number;
  onIndexChange: (index: number) => void;
}

const SWIPE_THRESHOLD = 50; // px — minimum horizontal delta to trigger switch
const DIRECTION_LOCK_RATIO = 1.5; // |deltaX| must be > |deltaY| * this to count as horizontal

/**
 * Horizontally-swipeable panel viewport. Renders children side-by-side
 * and translates between them via CSS transform. Touch-driven with
 * directional locking so vertical scrolls inside panels don't trigger
 * horizontal switches.
 *
 * Panels are positioned at translateX(-100% * activeIndex). During a
 * drag the transform follows the finger (no transition). On release:
 * above threshold → snap to new index, below → snap back to original.
 */
export function SwipeableViewport({
  children,
  activeIndex,
  onIndexChange,
}: SwipeableViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const lockedRef = useRef<'horizontal' | 'vertical' | null>(null);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    lockedRef.current = null;
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - startXRef.current;
    const deltaY = touch.clientY - startYRef.current;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // Lock direction on first significant move
    if (lockedRef.current === null) {
      if (absX > 10 || absY > 10) {
        lockedRef.current = absX > absY * DIRECTION_LOCK_RATIO ? 'horizontal' : 'vertical';
      }
      return;
    }

    if (lockedRef.current === 'horizontal') {
      e.preventDefault();
      setDragOffset(deltaX);
    }
  }, [isDragging]);

  const handleTouchEnd = useCallback(() => {
    if (!isDragging) return;
    setIsDragging(false);

    const absDelta = Math.abs(dragOffset);
    if (absDelta > SWIPE_THRESHOLD) {
      const direction = dragOffset > 0 ? -1 : 1;
      const newIndex = Math.max(0, Math.min(children.length - 1, activeIndex + direction));
      if (newIndex !== activeIndex) {
        onIndexChange(newIndex);
      }
    }
    setDragOffset(0);
    lockedRef.current = null;
  }, [isDragging, dragOffset, activeIndex, children.length, onIndexChange]);

  const translateX = -(activeIndex * 100) + (dragOffset / (containerRef.current?.offsetWidth || 1)) * 100;

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-hidden relative"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div
        className={cn(
          'flex h-full',
          !isDragging && 'transition-transform duration-200',
        )}
        style={{
          transform: `translateX(${translateX}%)`,
          width: `${children.length * 100}%`,
        }}
      >
        {children.map((child, i) => (
          <div key={i} className="flex-1 min-w-0 h-full overflow-hidden">
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit src/components/SwipeableViewport.tsx
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/SwipeableViewport.tsx
git commit -m "feat: add SwipeableViewport touch-swipe panel component

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Rewrite MobileTerminalLayout

**Files:**
- Modify: `web/src/components/MobileTerminalLayout.tsx` (full rewrite)
- Delete: `web/src/components/MobileFileTabs.tsx`
- Delete: `web/src/components/BottomSheet.tsx`

This is the core rewrite. The new `MobileTerminalLayout` contains:
- `SwipeableViewport` with 3 panels
- TerminalPanel: terminal + `CollapsibleInputBar` (shadcn `Collapsible` + `Tabs` for Input/Commands)
- FilesPanel: `FileBrowser` → `FileViewer` with internal nav stack (back arrow)
- EnvsPanel: `EnvPanel`
- `BottomNavIndicator`

- [ ] **Step 1: Remove old imports and replace with new MobileTerminalLayout**

Write the complete file:

```tsx
import { useState, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { EnvPanel } from './env/EnvPanel';
import { FileBrowser } from './FileBrowser';
import { FileViewer } from './FileViewer';
import { SwipeableViewport } from './SwipeableViewport';
import { BottomNavIndicator } from './BottomNavIndicator';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { FileOps, FileEntry } from '../services/fileOps';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

interface MobileTerminalLayoutProps {
  terminalElement: React.ReactNode | null;
  sessionId: string;
  sessionName?: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  fontSizeManager?: FontSizeManager | null;
  onGetTerminalPwd?: () => Promise<string>;
}

/**
 * Collapsible input bar below the terminal on mobile. Collapsed: terminal
 * fills to bottom. Expanded: tabs for Input (text entry) and Commands
 * (quick commands).
 */
function CollapsibleInputBar({
  sendText,
  disabled,
  collapsed,
  onToggle,
}: {
  sendText: (text: string) => void;
  disabled: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => { if (open !== !collapsed) onToggle(); }}
      className="flex-shrink-0 border-t bg-background"
    >
      <div className="flex items-center justify-between px-2 pt-1">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1 text-xs">
            {collapsed ? (
              <>
                <ChevronUp className="size-3" /> Input
              </>
            ) : (
              <>
                <ChevronDown className="size-3" /> Hide
              </>
            )}
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <Tabs defaultValue="input" className="flex flex-col">
          <TabsList className="mx-2 text-xs">
            <TabsTrigger value="input" className="text-xs gap-1">Input</TabsTrigger>
            <TabsTrigger value="commands" className="text-xs gap-1">Commands</TabsTrigger>
          </TabsList>
          <div className="h-[30vh] overflow-y-auto">
            <TabsContent value="input" className="mt-0 h-full">
              <InputPanel sendText={sendText} disabled={disabled} />
            </TabsContent>
            <TabsContent value="commands" className="mt-0 h-full">
              <QuickCommandsPanel sendText={sendText} disabled={disabled} />
            </TabsContent>
          </div>
        </Tabs>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Internal file navigation state for the Files panel on mobile.
 * Simple stack: FileBrowser → FileViewer with back arrow.
 */
function useFilesPanelNav(fileOps: FileOps, onGetTerminalPwd?: () => Promise<string>) {
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);

  const handleFileClick = useCallback((entry: FileEntry) => {
    setSelectedFile(entry);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedFile(null);
  }, []);

  const handleFileDeleted = useCallback((path: string) => {
    if (selectedFile && selectedFile.path === path) {
      setSelectedFile(null);
    }
  }, [selectedFile]);

  const handleFileRenamed = useCallback((oldPath: string, newPath: string) => {
    setSelectedFile((prev) => {
      if (prev && prev.path === oldPath) {
        const newName = newPath.split('/').pop() || newPath;
        return { ...prev, path: newPath, name: newName };
      }
      return prev;
    });
  }, []);

  return {
    selectedFile,
    handleFileClick,
    handleBack,
    handleFileDeleted,
    handleFileRenamed,
  };
}

/**
 * Mobile terminal layout with swipe-to-switch between Terminal, Files, and Envs.
 *
 * ┌─────────────────────────┐
 * │  SwipeableViewport      │
 * │  ┌────────────────────┐  │
 * │  │ Terminal │ Files   │  │  ← 3 panels, horizontal swipe
 * │  │          │  Envs   │  │
 * │  └────────────────────┘  │
 * ├─────────────────────────┤
 * │     · Terminal          │  ← BottomNavIndicator (non-interactive dots)
 * │     Files · Envs        │
 * └─────────────────────────┘
 */
export function MobileTerminalLayout({
  terminalElement,
  sessionId,
  sendText,
  toolbarDisabled,
  fileOps,
  onTerminalReveal,
  onGetTerminalPwd,
}: MobileTerminalLayoutProps) {
  const [activePanel, setActivePanel] = useState(0);
  const [inputCollapsed, setInputCollapsed] = useState(false);

  const {
    selectedFile,
    handleFileClick,
    handleBack,
    handleFileDeleted,
    handleFileRenamed,
  } = useFilesPanelNav(fileOps!, onGetTerminalPwd);

  const panels = [
    // Panel 0: Terminal
    <div key="terminal" className="h-full flex flex-col">
      {terminalElement ? (
        <div className="flex-1 min-h-0 relative">{terminalElement}</div>
      ) : (
        <div className="flex-1 min-h-0" />
      )}
      <CollapsibleInputBar
        sendText={sendText}
        disabled={toolbarDisabled}
        collapsed={inputCollapsed}
        onToggle={() => setInputCollapsed((prev) => !prev)}
      />
    </div>,

    // Panel 1: Files
    <div key="files" className="h-full flex flex-col">
      {selectedFile ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-2 px-2 py-1 border-b flex-shrink-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon" className="size-7" onClick={handleBack}>
                    <ArrowLeft className="size-4" />
                  </Button>
                }
              >
                <TooltipContent side="bottom"><p>Back to files</p></TooltipContent>
              </TooltipTrigger>
            </Tooltip>
            <span className="text-xs truncate">{selectedFile.name}</span>
          </div>
          <div className="flex-1 min-h-0">
            <FileViewer
              key={selectedFile.path}
              fileOps={fileOps!}
              path={selectedFile.path}
              filename={selectedFile.name}
              onClose={handleBack}
              onDirtyChange={() => {}}
            />
          </div>
        </div>
      ) : (
        <FileBrowser
          fileOps={fileOps!}
          onFileClick={handleFileClick}
          onFileDeleted={handleFileDeleted}
          onFileRenamed={handleFileRenamed}
          onGetTerminalPwd={onGetTerminalPwd}
        />
      )}
    </div>,

    // Panel 2: Envs
    <div key="envs" className="h-full">
      <EnvPanel sessionId={sessionId} />
    </div>,
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SwipeableViewport
        activeIndex={activePanel}
        onIndexChange={setActivePanel}
      >
        {panels}
      </SwipeableViewport>
      <BottomNavIndicator count={3} activeIndex={activePanel} />
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: Check for unused imports from deleted files**

Search for imports of deleted files:
```bash
grep -r "BottomSheet\|MobileFileTabs" web/src/ --include='*.ts' --include='*.tsx'
```

Expected: no imports remain. If any found, fix the importing file.

- [ ] **Step 4: Commit**

```bash
git rm web/src/components/BottomSheet.tsx web/src/components/MobileFileTabs.tsx
git add web/src/components/MobileTerminalLayout.tsx
git commit -m "feat: rewrite MobileTerminalLayout with swipe panels and collapsible input

- Replace BottomSheet + MobileFileTabs with SwipeableViewport + CollapsibleInputBar
- 3 swipeable panels: Terminal (with collapsible Input/Commands), Files (with back nav), Envs
- BottomNavIndicator for visual panel state
- Remove BottomSheet.tsx and MobileFileTabs.tsx

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Convert TerminalLayout to CSS-driven dual-mount

**Files:**
- Modify: `web/src/components/TerminalLayout.tsx`

- [ ] **Step 1: Rewrite TerminalLayout**

```tsx
import { useState } from 'react';
import { FileTabs } from './FileTabs';
import { EnvPanel } from './env/EnvPanel';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { MobileTerminalLayout } from './MobileTerminalLayout';
import { BottomBar, type BottomTab } from './BottomBar';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import type { FileOps } from '../services/fileOps';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

interface TerminalLayoutProps {
  terminalElement: React.ReactNode;
  sessionId: string;
  sessionName?: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  fontSizeManager?: FontSizeManager | null;
  onGetTerminalPwd?: () => Promise<string>;
}

/**
 * Shared layout for terminal view. Both mobile and desktop layouts are
 * always mounted; CSS `hidden` toggles visibility. This preserves layout
 * state (tab positions, scroll, panel index) across resize events.
 *
 * The terminalElement is rendered only in the currently-visible layout
 * to avoid dual xterm instances. A resize that flips the breakpoint will
 * unmount and remount the terminal, but xterm reconnects automatically.
 */
export function TerminalLayout({
  terminalElement,
  sessionId,
  sessionName,
  sendText,
  toolbarDisabled,
  fileOps,
  onTerminalReveal,
  fontSizeManager,
  onGetTerminalPwd,
}: TerminalLayoutProps) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [bottomTab, setBottomTab] = useState<BottomTab>('input');
  const [sheetOpen, setSheetOpen] = useState(false);

  const envPanel = <EnvPanel sessionId={sessionId} />;
  const inputPanel = <InputPanel sendText={sendText} disabled={toolbarDisabled} />;
  const commandsPanel = <QuickCommandsPanel sendText={sendText} disabled={toolbarDisabled} />;

  // ── Desktop path (≥1024px) ──────────────────────────────────────────
  const desktopContent = fileOps ? (
    <FileTabs
      fileOps={fileOps}
      onTerminalReveal={onTerminalReveal}
      bottomTab={bottomTab}
      onBottomTabChange={setBottomTab}
      sheetOpen={sheetOpen}
      onSheetToggle={setSheetOpen}
      envPanel={envPanel}
      inputPanel={inputPanel}
      commandsPanel={commandsPanel}
      sessionId={sessionId}
      sessionName={sessionName}
      onGetTerminalPwd={onGetTerminalPwd}
      terminalElement={
        isDesktop ? (
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
          </div>
        ) : null
      }
    />
  ) : (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        {isDesktop && terminalElement}
      </div>
      <BottomBar
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        showFilesTab={false}
        sheetOpen={sheetOpen}
        onSheetToggle={setSheetOpen}
        envPanel={envPanel}
        inputPanel={inputPanel}
        commandsPanel={commandsPanel}
      />
    </>
  );

  // ── Layout containers always mounted, hidden with CSS ──────────────

  return (
    <>
      {/* Mobile */}
      <div className={cn('flex-1 min-h-0 flex flex-col', isDesktop && 'hidden')}>
        <MobileTerminalLayout
          terminalElement={!isDesktop ? terminalElement : null}
          sessionId={sessionId}
          sessionName={sessionName}
          sendText={sendText}
          toolbarDisabled={toolbarDisabled}
          fileOps={fileOps}
          onTerminalReveal={onTerminalReveal}
          fontSizeManager={fontSizeManager}
          onGetTerminalPwd={onGetTerminalPwd}
        />
      </div>

      {/* Desktop */}
      <div className={cn('flex-1 min-h-0 flex flex-col', !isDesktop && 'hidden')}>
        {desktopContent}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify TypeScript and lint**

```bash
cd web && npx tsc --noEmit && npm run lint
```

- [ ] **Step 3: Fix any lint issues**

- [ ] **Step 4: Commit**

```bash
git add web/src/components/TerminalLayout.tsx
git commit -m "feat: use CSS-driven dual-mount in TerminalLayout

Both mobile and desktop layouts always mounted; visibility toggled
via hidden class. Layout state survives resize events. Terminal
element renders only in the active layout.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Convert FileTabs TabBar to shadcn Tabs

**Files:**
- Modify: `web/src/components/FileTabs.tsx`

Replace the hand-rolled `TabBar` function with shadcn `Tabs`. The `BottomBar` section stays unchanged. The `ResizablePanelGroup` structure stays unchanged.

- [ ] **Step 1: Replace the TabBar component**

Replace the `TabBar` function (lines 32–75) and the `tabBar` JSX usage (lines 100–110) with shadcn `Tabs`:

```tsx
// Imports to add at top:
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

// Replace the TabBar function with:
interface FileTabBarProps {
  openFiles: OpenFile[];
  activeTabId: string;
  dirtyFiles: Set<string>;
  showTerminal: boolean;
  terminalHeaderExtensions: React.ReactNode[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

function FileTabBar({
  openFiles,
  activeTabId,
  dirtyFiles,
  showTerminal,
  terminalHeaderExtensions,
  onSelect,
  onClose,
}: FileTabBarProps) {
  return (
    <Tabs
      value={showTerminal ? 'terminal' : activeTabId}
      onValueChange={(v) => onSelect(v)}
      className="flex-shrink-0"
    >
      <TabsList className="rounded-none border-b bg-muted/20 h-auto p-0 gap-0 overflow-x-auto w-full justify-start">
        <TabsTrigger
          value="terminal"
          className="gap-1 text-xs rounded-none border-r border-b-2 border-b-transparent data-[state=active]:border-b-primary data-[state=active]:bg-background h-auto py-1.5 px-3 flex-shrink-0"
        >
          <Terminal className="size-3" data-icon="inline-start" />
          Terminal
        </TabsTrigger>

        {terminalHeaderExtensions}

        {openFiles.map((file) => (
          <TabsTrigger
            key={file.id}
            value={file.id}
            className="group gap-1 text-xs rounded-none border-r border-b-2 border-b-transparent data-[state=active]:border-b-primary data-[state=active]:bg-background h-auto py-1.5 px-3 flex-shrink-0 max-w-[160px]"
          >
            <span className="truncate">{file.filename}</span>
            {dirtyFiles.has(file.id) && (
              <span className="size-1.5 rounded-full bg-amber-500 flex-shrink-0" />
            )}
            <X
              className="size-3 flex-shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive ml-0.5 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                onClose(file.id);
              }}
            />
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
```

- [ ] **Step 2: Update the main content section**

Replace `const tabBar = (<TabBar ... />)` with `const fileTabBar = (<FileTabBar ... />)` and update the JSX.

In the `FileTabs` function, replace:
```tsx
const tabBar = (
  <TabBar
    openFiles={openFiles}
    ...
  />
);
```
with:
```tsx
const fileTabBar = (
  <FileTabBar
    openFiles={openFiles}
    activeTabId={activeTabId}
    dirtyFiles={dirtyFiles}
    showTerminal={showTerminal}
    terminalHeaderExtensions={terminalHeaderExtensions}
    onSelect={setActiveTabId}
    onClose={handleCloseFile}
  />
);
```

Then in the JSX that renders the main content column, replace `{tabBar}` with `{fileTabBar}` in both desktop and mobile branches.

- [ ] **Step 3: Remove old TabBar interface and unused imports**

Remove the old `TabBarProps` interface (lines 32–40) and the old `TabBar` function (lines 43–75). Remove the unused `cn` import if it was only used by the old TabBar (check if `cn` is used elsewhere in the file).

Also remove the `ResizablePanelGroup` and related imports if they're no longer needed — check: they're still used for the desktop layout, so they stay.

The imports section should change from:
```tsx
import { X, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
```
to just:
```tsx
import { X, Terminal } from 'lucide-react';
```
(only if `cn` was used exclusively by the old TabBar — verify after the edit)

- [ ] **Step 4: Verify TypeScript and lint**

```bash
cd web && npx tsc --noEmit && npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FileTabs.tsx
git commit -m "feat: replace hand-rolled TabBar with shadcn Tabs

Use Tabs/TabsList/TabsTrigger for the file tab strip. Close button
shows on hover via group-hover:opacity-100. Dirty dot and extension
tabs preserved.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Integration verification

**Files:** N/A (verification only)

- [ ] **Step 1: Full TypeScript check**

```bash
cd web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 2: ESLint check**

```bash
cd web && npm run lint
```
Expected: 0 warnings, 0 errors. Fix any issues.

- [ ] **Step 3: Run existing tests**

```bash
cd web && npm test
```
Expected: all tests pass. Fix any failures.

- [ ] **Step 4: Build check**

```bash
cd web && npm run build
```
Expected: build succeeds.

- [ ] **Step 5: Manual checklist**

Verify the following by running the app locally (`npm run dev` + server + agent):
- [ ] Desktop (≥1024px): SidePanel + ResizableHandle + Terminal with FileTabs + BottomBar all visible
- [ ] Desktop: File tab strip uses shadcn Tabs, close button visible on hover
- [ ] Desktop: Resize handle between SidePanel and main content works
- [ ] Mobile (<1024px): 3-panel swipe viewport with Terminal, Files, Envs
- [ ] Mobile: Swipe left/right switches between panels
- [ ] Mobile: BottomNavIndicator shows correct active dot
- [ ] Mobile: CollapsibleInputBar expands/collapses Input + Commands tabs
- [ ] Mobile: Files panel: FileBrowser → tap file → FileViewer with back arrow → back to FileBrowser
- [ ] Mobile: Envs panel shows environment variables
- [ ] Resize browser between mobile and desktop: layout switches without page reload
- [ ] Terminal stays connected after layout switch

- [ ] **Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "chore: fix integration issues from terminal redesign

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review Notes

- Spec coverage: All 3 mobile panels (Terminal + CollapsibleInputBar, Files with nav stack, Envs) — covered by Task 3. CSS-driven switching — covered by Task 4. Desktop TabBar → shadcn Tabs — covered by Task 5. BottomSheet/MobileFileTabs removal — covered by Task 3 Step 4. SwipeableViewport + BottomNavIndicator — covered by Tasks 1–2.
- Placeholder scan: no TBD/TODO/placeholders.
- Type consistency: `MobileTerminalLayoutProps.terminalElement` changed from `React.ReactNode` to `React.ReactNode | null` because TerminalLayout passes `null` when inactive. Both the component and its callers handle this.

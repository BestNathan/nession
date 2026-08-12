# Mobile Panel Layout Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Terminal panel (quick actions in collapsed state, proper xterm refit) and Files panel (60/40 top-bottom split with collapsible FileBrowser) within MobileTerminalLayout.

**Architecture:** All changes are within `MobileTerminalLayout.tsx`. The old `CollapsibleInputBar` is replaced by `TerminalInputBar` (quick-action buttons in collapsed state). The Files panel section is replaced by a new `FilesPanel` component that renders FileViewer (top 60%) + collapsible FileBrowser (bottom 40%).

**Tech Stack:** React 18, TypeScript, Tailwind v4, shadcn/ui base-ui

---

## File Structure

```
web/src/components/
└── MobileTerminalLayout.tsx  [MODIFY]  Rewrite CollapsibleInputBar + Files panel section
```

All changes are in one file. If the file exceeds 300 lines, extract `TerminalInputBar` and `FilesPanel` into separate files.

---

### Task 1: Rewrite TerminalInputBar with quick actions and xterm refit

**Files:**
- Modify: `web/src/components/MobileTerminalLayout.tsx` (lines 34–93, replace `CollapsibleInputBar`)

- [ ] **Step 1: Replace CollapsibleInputBar with new TerminalInputBar**

Delete the existing `CollapsibleInputBar` function (lines 34–93) and replace with:

```tsx
interface TerminalInputBarProps {
  sendText: (text: string) => void;
  disabled: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onReveal?: () => void;
}

/**
 * Collapsible input bar below the terminal. Collapsed: compact toolbar
 * with quick-action buttons. Expanded: full Tabs (Input | Commands).
 * Triggers onReveal after animation so the terminal refits.
 */
function TerminalInputBar({
  sendText,
  disabled,
  collapsed,
  onToggle,
  onReveal,
}: TerminalInputBarProps) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open !== !collapsed) {
        onToggle();
        // Wait for collapse animation (~200ms), then trigger terminal refit
        setTimeout(() => onReveal?.(), 250);
      }
    },
    [collapsed, onToggle, onReveal],
  );

  return (
    <Tabs defaultValue="input" className="flex-shrink-0 border-t bg-background">
      <Collapsible open={!collapsed} onOpenChange={handleOpenChange}>
        {/* Toolbar — always visible */}
        <div className="flex items-center gap-1 px-2 h-9">
          {/* Collapse toggle */}
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm" className="gap-1 text-xs h-7">
                {collapsed ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
                {collapsed ? 'Input & Commands' : 'Hide'}
              </Button>
            }
          />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Quick-action buttons — only when collapsed */}
          {collapsed && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => sendText('\x03')}
                      disabled={disabled}
                      aria-label="Send Ctrl-C"
                    />
                  }
                >
                  <Square className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="top"><p>Ctrl-C</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => sendText('clear\n')}
                      disabled={disabled}
                      aria-label="Clear terminal"
                    />
                  }
                >
                  <Trash2 className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="top"><p>Clear</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => sendText('\x12')}
                      disabled={disabled}
                      aria-label="Send Ctrl-R"
                    />
                  }
                >
                  <Search className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent side="top"><p>Ctrl-R</p></TooltipContent>
              </Tooltip>
            </>
          )}

          {/* Tab switcher — only visible when expanded */}
          {!collapsed && (
            <TabsList className="text-xs h-7">
              <TabsTrigger value="input" className="text-xs gap-1 px-2 h-6">
                Input
              </TabsTrigger>
              <TabsTrigger value="commands" className="text-xs gap-1 px-2 h-6">
                Commands
              </TabsTrigger>
            </TabsList>
          )}
        </div>

        {/* Content — only when expanded */}
        <CollapsibleContent className="overflow-hidden">
          <Separator />
          <div className="max-h-[35vh] overflow-y-auto">
            <TabsContent value="input" className="mt-0">
              <InputPanel sendText={sendText} disabled={disabled} />
            </TabsContent>
            <TabsContent value="commands" className="mt-0">
              <QuickCommandsPanel sendText={sendText} disabled={disabled} />
            </TabsContent>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Tabs>
  );
}
```

- [ ] **Step 2: Add missing imports at the top of the file**

Add to imports:
```tsx
import { Square, Trash2, Search } from 'lucide-react';
import { Separator } from './ui/separator';
```

Remove old unused imports (`ChevronUp`, `ChevronDown` should stay — already imported).

- [ ] **Step 3: Update the Terminal panel JSX**

Replace the `CollapsibleInputBar` usage in the `panels` array (around line 168) with:

```tsx
<TerminalInputBar
  sendText={sendText}
  disabled={toolbarDisabled}
  collapsed={inputCollapsed}
  onToggle={() => setInputCollapsed((prev) => !prev)}
  onReveal={onTerminalReveal}
/>
```

Keep the rest of the Terminal panel unchanged:
```tsx
// Panel 0: Terminal
<div key="terminal" className="h-full flex flex-col">
  {terminalElement ? (
    <div className="flex-1 min-h-0 relative">{terminalElement}</div>
  ) : (
    <div className="flex-1 min-h-0" />
  )}
  <TerminalInputBar
    sendText={sendText}
    disabled={toolbarDisabled}
    collapsed={inputCollapsed}
    onToggle={() => setInputCollapsed((prev) => !prev)}
    onReveal={onTerminalReveal}
  />
</div>,
```

- [ ] **Step 4: Verify TypeScript and lint**

```bash
cd web && npx tsc --noEmit && npm run lint
```

Fix any errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/MobileTerminalLayout.tsx
git commit -m "feat: redesign TerminalInputBar with quick actions and refit trigger

- Replace CollapsibleInputBar with TerminalInputBar
- Collapsed: toggle + Ctrl-C / Clear / Ctrl-R quick-action buttons
- Expanded: full Tabs (Input | Commands) with Separator
- Fire onTerminalReveal after collapse animation for xterm refit

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Rewrite Files panel as top-bottom split with collapsible browser

**Files:**
- Modify: `web/src/components/MobileTerminalLayout.tsx` (the Files panel section)

- [ ] **Step 1: Extract FilesPanel component**

Add the following component before `MobileTerminalLayout`:

```tsx
interface FilesPanelProps {
  fileOps: FileOps;
  onGetTerminalPwd?: () => Promise<string>;
}

/**
 * Files panel with top-bottom split layout.
 * Top: FileViewer (or empty state) — 60% when browser is visible, 100% when collapsed
 * Bottom: Collapsible FileBrowser — 40% when visible
 * Toggle chevron at the bottom of the panel.
 */
function FilesPanel({ fileOps, onGetTerminalPwd }: FilesPanelProps) {
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const {
    selectedFile,
    handleFileClick,
    handleFileDeleted,
    handleFileRenamed,
  } = useFilesPanelNav();

  return (
    <div className="h-full flex flex-col">
      {/* FileViewer area — flex-1 when collapsed, flex-[6] when expanded */}
      <div
        className={cn(
          'min-h-0 flex flex-col',
          browserCollapsed ? 'flex-1' : 'flex-[6]',
        )}
      >
        {selectedFile ? (
          <>
            {/* File header bar */}
            <div className="flex items-center gap-2 px-2 py-1 border-b flex-shrink-0">
              <span className="text-xs font-medium truncate">{selectedFile.name}</span>
              <div className="flex-1" />
              <Badge variant="secondary" className="text-[10px] h-4 px-1">
                {selectedFile.path}
              </Badge>
            </div>
            <div className="flex-1 min-h-0">
              <FileViewer
                key={selectedFile.path}
                fileOps={fileOps}
                path={selectedFile.path}
                filename={selectedFile.name}
                onClose={() => {}}
                onDirtyChange={() => {}}
              />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Select a file to view
          </div>
        )}
      </div>

      {/* Divider between viewer and browser */}
      {!browserCollapsed && <Separator />}

      {/* FileBrowser area — hidden when collapsed, flex-[4] when expanded */}
      <div
        className={cn(
          'border-t bg-background flex-shrink-0 flex flex-col',
          browserCollapsed ? 'hidden' : 'flex-[4] min-h-0',
        )}
      >
        {/* Collapse toggle */}
        <div className="flex items-center px-2 h-8 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-xs h-6"
            onClick={() => setBrowserCollapsed((prev) => !prev)}
          >
            {browserCollapsed ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
            Files
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <FileBrowser
            fileOps={fileOps}
            onFileClick={handleFileClick}
            onFileDeleted={handleFileDeleted}
            onFileRenamed={handleFileRenamed}
            onGetTerminalPwd={onGetTerminalPwd}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add missing imports**

```tsx
import { Badge } from './ui/badge';
import { cn } from '@/lib/utils';
```

(Check if `cn` is already imported — skip if so. `Badge` may already be imported.)

- [ ] **Step 3: Replace Files panel JSX**

Replace the entire Files panel section in the `panels` array (currently lines 176–217) with:

```tsx
// Panel 1: Files
<div key="files" className="h-full flex flex-col">
  {fileOps ? (
    <FilesPanel fileOps={fileOps} onGetTerminalPwd={onGetTerminalPwd} />
  ) : (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      File browser unavailable
    </div>
  )}
</div>,
```

- [ ] **Step 4: Remove unused useFilesPanelNav from MobileTerminalLayout**

`FilesPanel` now calls its own `useFilesPanelNav()` internally. The outer call in `MobileTerminalLayout` body is no longer needed.

Remove the entire `useFilesPanelNav()` call and destructuring from `MobileTerminalLayout`:
```tsx
// DELETE these lines from MobileTerminalLayout body:
const {
  selectedFile,
  handleFileClick,
  handleBack,
  handleFileDeleted,
  handleFileRenamed,
} = useFilesPanelNav();
```

Also remove unused destructured values from props if no longer needed. Keep `useFilesPanelNav` function itself — it's used by `FilesPanel`.

- [ ] **Step 5: Verify TypeScript and lint**

```bash
cd web && npx tsc --noEmit && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add web/src/components/MobileTerminalLayout.tsx
git commit -m "feat: redesign Files panel as 60/40 top-bottom split

- FileViewer/editor on top (60%, or 100% when browser collapsed)
- Collapsible FileBrowser on bottom (40%)
- Empty state when no file selected
- Toggle chevron to show/hide FileBrowser
- Handle back button removed — browser is always accessible

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Integration verification

**Files:** N/A (verification only)

- [ ] **Step 1: Full TypeScript check**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 2: ESLint check**

```bash
cd web && npm run lint
```

- [ ] **Step 3: Run tests**

```bash
cd web && npm test
```

- [ ] **Step 4: Build check**

```bash
cd web && npm run build
```

- [ ] **Step 5: Manual verification via Playwright**

Verify the following at mobile viewport (375x812):
- [ ] Terminal panel: collapsed toolbar shows Ctrl-C, Clear, Ctrl-R buttons
- [ ] Terminal panel: clicking toggle expands to show Input/Commands tabs
- [ ] Terminal panel: terminal resizes when input bar expands/collapses
- [ ] Files panel: 60/40 split with FileViewer on top, FileBrowser on bottom
- [ ] Files panel: clicking ▼ hides FileBrowser, FileViewer fills 100%
- [ ] Files panel: empty state "Select a file to view" when no file selected

- [ ] **Step 6: Final commit (if fixes needed)**

```bash
git add -A
git commit -m "chore: fix integration issues from panel layout redesign

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review Notes

- Spec coverage: Terminal quick actions ✅ (Task 1), xterm refit ✅ (Task 1 Step 1 `handleOpenChange`), Files 60/40 split ✅ (Task 2), Files collapsible browser ✅ (Task 2), consistent collapse UX ✅ (both use chevron + Button).
- Placeholder scan: no TBD/TODO.
- Type consistency: `TerminalInputBar` adds `onReveal` prop wired to `onTerminalReveal`. `FilesPanel` uses `useFilesPanelNav()` internally (own instance) — this is fine since each panel has its own state. But `MobileTerminalLayout` still destructures `useFilesPanelNav()` for the old code — Task 2 Step 4 removes the unused destructured values.

# WebUI Code Quality Enhancement - Design Spec

**Date:** 2026-07-16  
**Issues:** #67, #68, #69  
**Scope:** Extract shared utilities, simplify Dashboard architecture, reduce FileBrowser complexity  
**Approach:** Bottom-up (utilities first → component refactoring)

---

## Overview

This spec addresses three related code quality enhancement issues to improve maintainability, reduce duplication, and make the codebase easier to understand and modify. All changes are pure refactoring with no behavior changes.

**Expected Impact:**
- Reduce code duplication by ~200+ lines
- Make patterns discoverable and testable
- Simplify component architecture
- Easier to add new features or modify existing ones

---

## Part 1: Shared Utilities Layer (#67)

### 1.1 Utility Functions

#### `lib/errorHelpers.ts` - Toast Error Helper

**Purpose:** Eliminate repeated error handling pattern in async handlers

**Implementation:**
```typescript
import { toast } from 'sonner';

export function toastError(err: unknown, fallback: string): void {
  toast.error(err instanceof Error ? err.message : fallback);
}
```

**Usage Sites:**
- `FileBrowser.tsx`: 5 catch blocks with identical error handling
- `FileViewer.tsx`: 2 catch blocks

**Before:**
```typescript
catch (err) {
  const msg = err instanceof Error ? err.message : 'Failed to load directory';
  setError(msg);
  toast.error(msg);
}
```

**After:**
```typescript
catch (err) {
  const msg = err instanceof Error ? err.message : 'Failed to load directory';
  setError(msg);
  toastError(err, msg);
}
```

---

#### `lib/idGenerator.ts` - ID Generation

**Purpose:** Centralize ID generation pattern

**Implementation:**
```typescript
export function generateId(prefix = ''): string {
  const id = `${Date.now()}-${Math.random()}`;
  return prefix ? `${prefix}-${id}` : id;
}
```

**Usage Sites:**
- `FileTabs.tsx`: Tab ID generation
- `TerminalToolbar.tsx`: Command ID generation

---

### 1.2 React Hooks

#### `hooks/useLatest.ts` - Latest Value Ref

**Purpose:** Keep a ref synchronized with the latest value, eliminating callback sync effects

**Implementation:**
```typescript
import { useRef, useEffect } from 'react';

export function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
```

**Usage Sites:**
- `Terminal.tsx`: 4 useEffect blocks syncing callback refs → replace with `useLatest`

**Before:**
```typescript
const onDisconnectRef = useRef(onDisconnect);
useEffect(() => {
  onDisconnectRef.current = onDisconnect;
}, [onDisconnect]);
```

**After:**
```typescript
const onDisconnectRef = useLatest(onDisconnect);
```

---

#### `hooks/useDialogReset.ts` - Dialog State Reset

**Purpose:** Reset dialog state when it opens

**Implementation:**
```typescript
import { useEffect } from 'react';

export function useDialogReset(isOpen: boolean, callback: () => void): void {
  useEffect(() => {
    if (isOpen) {
      callback();
    }
  }, [isOpen, callback]);
}
```

**Usage Sites:**
- `KillConfirmDialog.tsx`: Reset loading/error on open
- `CreateSessionDialog.tsx`: Reset loading/error on open

---

#### `hooks/useDebouncedInput.ts` - Debounced Input

**Purpose:** Encapsulate debounced input logic

**Implementation:**
```typescript
import { useState, useEffect } from 'react';

export function useDebouncedInput<T>(initialValue: T, delay = 300) {
  const [value, setValue] = useState(initialValue);
  const [debouncedValue, setDebouncedValue] = useState(initialValue);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return { value, setValue, debouncedValue };
}
```

**Usage Sites:**
- `SearchBar.tsx`: Extract existing debounced search logic (~30 lines)

---

### 1.3 UI Components

#### `components/ui/ConnectionStatusBadge.tsx` - Status Badge

**Purpose:** Unify connection status rendering across LoginPage and DashboardHeader

**Implementation:**
```typescript
import { Badge } from './badge';
import { cn } from '@/lib/utils';
import type { ConnectionStatus } from '../../types';

interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;
  showPulse?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<ConnectionStatus, { color: string; text: string }> = {
  disconnected: { color: 'bg-red-500', text: 'Disconnected' },
  connecting: { color: 'bg-amber-500', text: 'Connecting...' },
  connected: { color: 'bg-green-500', text: 'Connected' },
  authenticated: { color: 'bg-blue-500', text: 'Authenticated' },
};

export function ConnectionStatusBadge({ status, showPulse = true, className }: ConnectionStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  
  return (
    <Badge variant="outline" className={cn('flex items-center gap-2', className)}>
      <span className={cn('w-2 h-2 rounded-full', config.color, showPulse && 'animate-pulse')} />
      {config.text}
    </Badge>
  );
}
```

**Usage Sites:**
- `LoginPage.tsx`: Replace `getStatusColor`/`getStatusText` functions
- `DashboardHeader.tsx`: Replace inline status rendering

---

#### `components/ui/RefreshButton.tsx` - Refresh Button

**Purpose:** Eliminate duplicated refresh button with spinning icon

**Implementation:**
```typescript
import { RefreshCw } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

interface RefreshButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}

export function RefreshButton({ onClick, disabled, loading, className }: RefreshButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled || loading}
      className={cn('h-8 w-8 p-0', className)}
    >
      <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
    </Button>
  );
}
```

**Usage Sites:**
- `DashboardHeader.tsx`: Replace inline refresh button
- `SessionsSection.tsx`: Replace inline refresh button

---

## Part 2: FileBrowser Complexity Reduction (#68)

### 2.1 Current State

`FileBrowser.tsx` has:
- 13 useState calls making the component hard to follow
- 5 near-duplicate catch blocks
- `handleCreateFile` and `handleCreateFolder` differ only in API call and toast text

### 2.2 Refactoring Strategy

#### Custom Hook: `useNewEntryForm`

**Purpose:** Group new file/folder form state

**Implementation:**
```typescript
// hooks/useNewEntryForm.ts
export function useNewEntryForm() {
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newName, setNewName] = useState('');

  const reset = useCallback(() => {
    setShowNewFile(false);
    setShowNewFolder(false);
    setNewName('');
  }, []);

  return {
    showNewFile,
    showNewFolder,
    newName,
    setNewName,
    setShowNewFile,
    setShowNewFolder,
    reset,
  };
}
```

#### Custom Hook: `useRenameState`

**Purpose:** Group rename operation state

**Implementation:**
```typescript
// hooks/useRenameState.ts
export function useRenameState() {
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startRename = useCallback((path: string, currentName: string) => {
    setRenamingPath(path);
    setRenameValue(currentName);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
    setRenameValue('');
  }, []);

  return {
    renamingPath,
    renameValue,
    setRenameValue,
    startRename,
    cancelRename,
  };
}
```

#### Custom Hook: `useFileBrowserDialogs`

**Purpose:** Group dialog target state

**Implementation:**
```typescript
// hooks/useFileBrowserDialogs.ts
export function useFileBrowserDialogs() {
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [largeFileTarget, setLargeFileTarget] = useState<FileEntry | null>(null);

  return {
    deleteTarget,
    largeFileTarget,
    setDeleteTarget,
    setLargeFileTarget,
  };
}
```

#### Shared Create Handler

**Purpose:** Eliminate duplication between file and folder creation

**Implementation:**
```typescript
// In FileBrowser.tsx
const handleCreate = useCallback(async (name: string, kind: 'file' | 'folder') => {
  const trimmed = name.trim();
  if (!trimmed) return;
  
  const path = currentPath ? `${currentPath}/${trimmed}` : trimmed;
  try {
    if (kind === 'file') {
      await fileOps.createFile(path);
      toast.success(`Created file ${trimmed}`);
    } else {
      await fileOps.createFolder(path);
      toast.success(`Created folder ${trimmed}`);
    }
    await loadDir(currentPath);
    newEntryForm.reset();
  } catch (err) {
    toastError(err, `Failed to create ${kind}`);
  }
}, [currentPath, fileOps, loadDir, newEntryForm]);

const handleCreateFile = useCallback(() => {
  handleCreate(newEntryForm.newName, 'file');
}, [handleCreate, newEntryForm.newName]);

const handleCreateFolder = useCallback(() => {
  handleCreate(newEntryForm.newName, 'folder');
}, [handleCreate, newEntryForm.newName]);
```

### 2.3 Expected Reduction

- **Before:** ~400 lines
- **After:** ~250 lines
- **Improvement:** ~37% reduction

---

## Part 3: Dashboard Architecture Simplification (#69)

### 3.1 Inline DashboardModals

**Problem:** `DashboardModals` is a pure pass-through with 13 props and no logic

**Solution:** Inline dialogs directly in Dashboard component

**Before:**
```typescript
// Dashboard.tsx
<DashboardModals
  agents={agents}
  selectedAgent={selectedAgent}
  getHeartbeatHistory={getHeartbeatHistory}
  showCreateModal={showCreateModal}
  sessionToKill={sessionToKill}
  attachDialogSession={attachDialogSession}
  probeCache={probeCache}
  onCloseAgentDetail={() => setSelectedAgent(null)}
  onCloseCreateModal={() => setShowCreateModal(false)}
  onSessionCreated={handleSessionCreated}
  onCloseKillModal={() => setSessionToKill(null)}
  onSessionKilled={handleSessionKilled}
  onCloseAttachDialog={() => setAttachDialogSession(null)}
  onConfirmAttach={confirmAttach}
/>
```

**After:**
```typescript
// Dashboard.tsx
{selectedAgent && (
  <AgentDetailPanel
    agent={selectedAgent}
    heartbeatHistory={getHeartbeatHistory(selectedAgent.agent_id)}
    onClose={() => setSelectedAgent(null)}
  />
)}

<CreateSessionDialog
  isOpen={showCreateModal}
  onClose={() => setShowCreateModal(false)}
  agents={agents}
  preselectedAgentId={null}
  onCreated={handleSessionCreated}
/>

<KillConfirmDialog
  isOpen={sessionToKill !== null}
  onClose={() => setSessionToKill(null)}
  session={sessionToKill}
  onKilled={handleSessionKilled}
/>

<AttachDialog
  isOpen={attachDialogSession !== null}
  onClose={() => setAttachDialogSession(null)}
  session={attachDialogSession}
  onConfirm={confirmAttach}
  probeCache={probeCache}
/>
```

**Result:** Delete `DashboardModals.tsx` entirely

---

### 3.2 TerminalView Layout Extraction

**Problem:** `!fileOps` and `fileOps` branches duplicate BottomBar + EnvPanel + TerminalToolbar

**Solution:** Extract shared layout component

**Implementation:**
```typescript
// components/TerminalLayout.tsx
interface TerminalLayoutProps {
  terminalElement: React.ReactNode;
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
  sessionId: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
}

export function TerminalLayout({
  terminalElement,
  bottomTab,
  onBottomTabChange,
  sheetOpen,
  onSheetToggle,
  sessionId,
  sendText,
  toolbarDisabled,
  fileOps,
}: TerminalLayoutProps) {
  const envPanel = <EnvPanel sessionId={sessionId} />;
  const commandsPanel = (
    <TerminalToolbar sendText={sendText} disabled={toolbarDisabled} />
  );

  if (fileOps) {
    return (
      <FileTabs
        fileOps={fileOps}
        onTerminalReveal={() => {/* refit logic */}}
        bottomTab={bottomTab}
        onBottomTabChange={onBottomTabChange}
        sheetOpen={sheetOpen}
        onSheetToggle={onSheetToggle}
        envPanel={envPanel}
        commandsPanel={commandsPanel}
        terminalElement={
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
          </div>
        }
      />
    );
  }

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
      <BottomBar
        activeTab={bottomTab}
        onTabChange={onBottomTabChange}
        showFilesTab={false}
        sheetOpen={sheetOpen}
        onSheetToggle={onSheetToggle}
        envPanel={envPanel}
        commandsPanel={commandsPanel}
      />
    </>
  );
}
```

**TerminalView.tsx becomes:**
```typescript
<TerminalLayout
  terminalElement={terminalElement}
  bottomTab={bottomTab}
  onBottomTabChange={setBottomTab}
  sheetOpen={sheetOpen}
  onSheetToggle={setSheetOpen}
  sessionId={sessionId}
  sendText={(text) => terminalRef.current?.sendText(text)}
  toolbarDisabled={toolbarDisabled}
  fileOps={fileOps}
/>
```

---

### 3.3 BottomBar Tab Buttons

**Problem:** Three tab buttons with identical JSX, only icon/label/value differ

**Solution:** Map over tab configuration array

**Before:**
```typescript
<button onClick={() => selectTab('commands')} className={...}>
  <TerminalIcon className="w-3 h-3" /> Commands
</button>
<button onClick={() => selectTab('env')} className={...}>
  <Package className="w-3 h-3" /> Env
</button>
{showFilesTab && (
  <button onClick={() => selectTab('files')} className={...}>
    <FolderTree className="w-3 h-3" /> Files
  </button>
)}
```

**After:**
```typescript
const tabs = [
  { id: 'commands' as const, icon: TerminalIcon, label: 'Commands' },
  { id: 'env' as const, icon: Package, label: 'Env' },
  { id: 'files' as const, icon: FolderTree, label: 'Files', conditional: showFilesTab },
];

{tabs.map(({ id, icon: Icon, label, conditional }) => {
  if (conditional === false) return null;
  return (
    <button
      key={id}
      type="button"
      onClick={() => selectTab(id)}
      className={cn(
        'flex items-center gap-1 px-3 py-1 text-xs transition-colors border-b-2 -mb-px',
        effectiveTab === id
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="w-3 h-3" /> {label}
    </button>
  );
})}
```

---

### 3.4 LoginPage Status Lookup

**Problem:** Three separate switch functions for status metadata

**Solution:** Consolidate into single lookup table (already handled by `ConnectionStatusBadge` component)

**Before:**
```typescript
function getStatusColor(status: ConnectionStatus): string { ... }
function getStatusText(status: ConnectionStatus): string { ... }
function getHelperText(status: ConnectionStatus): string { ... }
```

**After:**
```typescript
// In ConnectionStatusBadge.tsx
const STATUS_CONFIG: Record<ConnectionStatus, { color: string; text: string }> = {
  disconnected: { color: 'bg-red-500', text: 'Disconnected' },
  connecting: { color: 'bg-amber-500', text: 'Connecting...' },
  connected: { color: 'bg-green-500', text: 'Connected' },
  authenticated: { color: 'bg-blue-500', text: 'Authenticated' },
};

// For helper text (still needed in LoginPage)
const HELPER_TEXT: Record<ConnectionStatus, string> = {
  disconnected: 'Enter your auth token and click Connect to establish a WebSocket connection to the server.',
  connecting: 'Establishing connection to the server...',
  connected: 'Connected! Authenticating...',
  authenticated: '',
};
```

---

## Implementation Order

1. **Phase 1 - Shared Utilities (#67):**
   - Create `lib/errorHelpers.ts`
   - Create `lib/idGenerator.ts`
   - Create `hooks/useLatest.ts`
   - Create `hooks/useDialogReset.ts`
   - Create `hooks/useDebouncedInput.ts`
   - Create `components/ui/ConnectionStatusBadge.tsx`
   - Create `components/ui/RefreshButton.tsx`

2. **Phase 2 - FileBrowser Refactoring (#68):**
   - Create `hooks/useNewEntryForm.ts`
   - Create `hooks/useRenameState.ts`
   - Create `hooks/useFileBrowserDialogs.ts`
   - Refactor `FileBrowser.tsx` to use custom hooks
   - Apply `toastError` helper
   - Consolidate create handlers

3. **Phase 3 - Dashboard Simplification (#69):**
   - Inline `DashboardModals` into `Dashboard.tsx`
   - Delete `DashboardModals.tsx`
   - Create `components/TerminalLayout.tsx`
   - Refactor `TerminalView.tsx` to use `TerminalLayout`
   - Refactor `BottomBar.tsx` to use tab mapping
   - Refactor `LoginPage.tsx` to use `ConnectionStatusBadge`
   - Refactor `DashboardHeader.tsx` to use `ConnectionStatusBadge` and `RefreshButton`
   - Refactor `SessionsSection.tsx` to use `RefreshButton`

---

## Testing Strategy

Since this is pure refactoring:
- All existing tests should continue to pass
- No new tests needed (behavior unchanged)
- Manual verification via Playwright screenshots for UI components

---

## Success Criteria

- All 3 issues closed
- Code duplication reduced by ~200+ lines
- Component architecture clearer (DashboardModals eliminated)
- FileBrowser reduced from ~400 to ~250 lines
- All patterns extracted and reusable
- No behavior changes
- All tests pass
- Lint passes with zero warnings

---

## Risks and Mitigations

**Risk:** Breaking existing functionality during refactoring  
**Mitigation:** 
- Run all tests after each phase
- Manual Playwright verification for UI changes
- Small, focused commits per refactoring unit

**Risk:** Over-extraction (creating utilities that aren't used)  
**Mitigation:** 
- Only extract patterns explicitly mentioned in issues
- Each utility has clear usage sites documented

**Risk:** Merge conflicts with other branches  
**Mitigation:** 
- Work in isolated worktree
- Regular rebasing from main

# WebUI Code Quality Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce code duplication by ~200+ lines, simplify component architecture, and make patterns discoverable through systematic extraction of shared utilities, hooks, and components.

**Architecture:** Bottom-up approach: extract shared utilities first (Phase 1), then refactor components to use them (Phase 2-3). All changes are pure refactoring with no behavior changes.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, shadcn/ui, Vitest

**Spec:** `docs/superpowers/specs/2026-07-16-webui-code-quality-enhancement.md`

---

## File Structure

### New Files (Phase 1 - Shared Utilities)
- `web/src/lib/errorHelpers.ts` - Toast error helper
- `web/src/lib/idGenerator.ts` - ID generation utility
- `web/src/hooks/useLatest.ts` - Latest value ref hook
- `web/src/hooks/useDialogReset.ts` - Dialog state reset hook
- `web/src/hooks/useDebouncedInput.ts` - Debounced input hook
- `web/src/hooks/useNewEntryForm.ts` - New file/folder form state
- `web/src/hooks/useRenameState.ts` - Rename operation state
- `web/src/hooks/useFileBrowserDialogs.ts` - Dialog target state
- `web/src/components/ui/ConnectionStatusBadge.tsx` - Status badge component
- `web/src/components/ui/RefreshButton.tsx` - Refresh button component
- `web/src/components/TerminalLayout.tsx` - Shared terminal layout

### Modified Files (Phase 2-3)
- `web/src/components/FileBrowser.tsx` - Refactor to use custom hooks
- `web/src/components/FileTabs.tsx` - Use generateId
- `web/src/components/TerminalToolbar.tsx` - Use generateId
- `web/src/components/Terminal.tsx` - Use useLatest
- `web/src/components/KillConfirmDialog.tsx` - Use useDialogReset
- `web/src/components/CreateSessionDialog.tsx` - Use useDialogReset
- `web/src/components/SearchBar.tsx` - Use useDebouncedInput
- `web/src/components/LoginPage.tsx` - Use ConnectionStatusBadge
- `web/src/components/DashboardHeader.tsx` - Use ConnectionStatusBadge + RefreshButton
- `web/src/components/SessionsSection.tsx` - Use RefreshButton
- `web/src/components/Dashboard.tsx` - Inline DashboardModals
- `web/src/components/TerminalView.tsx` - Use TerminalLayout

### Deleted Files
- `web/src/components/DashboardModals.tsx` - Eliminated (pure pass-through)

---

## Phase 1: Shared Utilities (#67)

### Task 1: Create Toast Error Helper

**Files:**
- Create: `web/src/lib/errorHelpers.ts`
- Modify: `web/src/components/FileBrowser.tsx`
- Modify: `web/src/components/FileViewer.tsx`

- [ ] **Step 1: Create errorHelpers.ts**

```typescript
// web/src/lib/errorHelpers.ts
import { toast } from 'sonner';

/**
 * Show a toast error message from an unknown error.
 * Uses err.message if err is an Error, otherwise uses fallback.
 */
export function toastError(err: unknown, fallback: string): void {
  toast.error(err instanceof Error ? err.message : fallback);
}
```

- [ ] **Step 2: Update FileBrowser.tsx to use toastError**

Replace all 5 instances of this pattern:
```typescript
// Before
catch (err) {
  const msg = err instanceof Error ? err.message : 'Failed to ...';
  setError(msg);
  toast.error(msg);
}

// After
catch (err) {
  const msg = err instanceof Error ? err.message : 'Failed to ...';
  setError(msg);
  toastError(err, msg);
}
```

Add import at top:
```typescript
import { toastError } from '@/lib/errorHelpers';
```

- [ ] **Step 3: Update FileViewer.tsx to use toastError**

Replace 2 instances of the same pattern. Add import.

- [ ] **Step 4: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/errorHelpers.ts web/src/components/FileBrowser.tsx web/src/components/FileViewer.tsx
git commit -m "refactor: extract toastError helper to eliminate duplication

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Create ID Generator Utility

**Files:**
- Create: `web/src/lib/idGenerator.ts`
- Modify: `web/src/components/FileTabs.tsx`
- Modify: `web/src/components/TerminalToolbar.tsx`

- [ ] **Step 1: Create idGenerator.ts**

```typescript
// web/src/lib/idGenerator.ts
/**
 * Generate a unique ID using timestamp + random number.
 * Optional prefix for namespacing.
 */
export function generateId(prefix = ''): string {
  const id = `${Date.now()}-${Math.random()}`;
  return prefix ? `${prefix}-${id}` : id;
}
```

- [ ] **Step 2: Update FileTabs.tsx**

Find the line with `Date.now()-Math.random()` pattern and replace:
```typescript
// Before
const id = `tab-${Date.now()}-${Math.random()}`;

// After
import { generateId } from '@/lib/idGenerator';
const id = generateId('tab');
```

- [ ] **Step 3: Update TerminalToolbar.tsx**

Replace the same pattern:
```typescript
// Before
const id = `cmd-${Date.now()}-${Math.random()}`;

// After
import { generateId } from '@/lib/idGenerator';
const id = generateId('cmd');
```

- [ ] **Step 4: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/idGenerator.ts web/src/components/FileTabs.tsx web/src/components/TerminalToolbar.tsx
git commit -m "refactor: extract generateId utility for consistent ID generation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Create useLatest Hook

**Files:**
- Create: `web/src/hooks/useLatest.ts`
- Modify: `web/src/components/Terminal.tsx`

- [ ] **Step 1: Create useLatest.ts**

```typescript
// web/src/hooks/useLatest.ts
import { useRef, useEffect } from 'react';

/**
 * Keep a ref synchronized with the latest value.
 * Eliminates the need for useEffect blocks that just sync refs.
 */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
```

- [ ] **Step 2: Update Terminal.tsx**

Find all useEffect blocks that sync callback refs (should be ~4 blocks) and replace with useLatest:

```typescript
// Before (repeated ~4 times)
const onDisconnectRef = useRef(onDisconnect);
useEffect(() => {
  onDisconnectRef.current = onDisconnect;
}, [onDisconnect]);

// After
import { useLatest } from '../hooks/useLatest';
const onDisconnectRef = useLatest(onDisconnect);
```

Remove the corresponding useEffect blocks.

- [ ] **Step 3: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useLatest.ts web/src/components/Terminal.tsx
git commit -m "refactor: extract useLatest hook to eliminate callback sync effects

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Create useDialogReset Hook

**Files:**
- Create: `web/src/hooks/useDialogReset.ts`
- Modify: `web/src/components/KillConfirmDialog.tsx`
- Modify: `web/src/components/CreateSessionDialog.tsx`

- [ ] **Step 1: Create useDialogReset.ts**

```typescript
// web/src/hooks/useDialogReset.ts
import { useEffect } from 'react';

/**
 * Reset dialog state when it opens.
 * Common pattern: clear loading/error state when dialog becomes visible.
 */
export function useDialogReset(isOpen: boolean, callback: () => void): void {
  useEffect(() => {
    if (isOpen) {
      callback();
    }
  }, [isOpen, callback]);
}
```

- [ ] **Step 2: Update KillConfirmDialog.tsx**

Find the useEffect that resets state on isOpen and replace:

```typescript
// Before
useEffect(() => {
  if (isOpen) {
    setLoading(false);
    setError(null);
  }
}, [isOpen]);

// After
import { useDialogReset } from '../hooks/useDialogReset';
import { useCallback } from 'react';

const resetState = useCallback(() => {
  setLoading(false);
  setError(null);
}, []);
useDialogReset(isOpen, resetState);
```

- [ ] **Step 3: Update CreateSessionDialog.tsx**

Apply the same pattern.

- [ ] **Step 4: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useDialogReset.ts web/src/components/KillConfirmDialog.tsx web/src/components/CreateSessionDialog.tsx
git commit -m "refactor: extract useDialogReset hook for dialog state management

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Create useDebouncedInput Hook

**Files:**
- Create: `web/src/hooks/useDebouncedInput.ts`
- Modify: `web/src/components/SearchBar.tsx`

- [ ] **Step 1: Create useDebouncedInput.ts**

```typescript
// web/src/hooks/useDebouncedInput.ts
import { useState, useEffect } from 'react';

/**
 * Debounced input hook for search fields.
 * Returns current value, setter, and debounced value.
 */
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

- [ ] **Step 2: Update SearchBar.tsx**

Extract the existing debounced logic (~30 lines) into the hook:

```typescript
// Before
const [query, setQuery] = useState('');
const [debouncedQuery, setDebouncedQuery] = useState('');
useEffect(() => {
  const timer = setTimeout(() => setDebouncedQuery(query), 300);
  return () => clearTimeout(timer);
}, [query]);

// After
import { useDebouncedInput } from '../hooks/useDebouncedInput';
const { value: query, setValue: setQuery, debouncedValue: debouncedQuery } = useDebouncedInput('', 300);
```

- [ ] **Step 3: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useDebouncedInput.ts web/src/components/SearchBar.tsx
git commit -m "refactor: extract useDebouncedInput hook from SearchBar

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Create ConnectionStatusBadge Component

**Files:**
- Create: `web/src/components/ui/ConnectionStatusBadge.tsx`
- Modify: `web/src/components/LoginPage.tsx`
- Modify: `web/src/components/DashboardHeader.tsx`

- [ ] **Step 1: Create ConnectionStatusBadge.tsx**

```typescript
// web/src/components/ui/ConnectionStatusBadge.tsx
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

- [ ] **Step 2: Update LoginPage.tsx**

Replace the three switch functions and inline badge rendering:

```typescript
// Remove these functions:
// function getStatusColor(status: ConnectionStatus): string { ... }
// function getStatusText(status: ConnectionStatus): string { ... }
// function getHelperText(status: ConnectionStatus): string { ... }

// Add import:
import { ConnectionStatusBadge } from './ui/ConnectionStatusBadge';

// Replace inline badge rendering:
// Before:
<Badge variant="outline" className="flex items-center gap-2">
  <span className={cn('w-2 h-2 rounded-full', getStatusColor(connectionStatus), 'animate-pulse')} />
  {getStatusText(connectionStatus)}
</Badge>

// After:
<ConnectionStatusBadge status={connectionStatus} />

// For helper text, keep a simple lookup:
const HELPER_TEXT: Record<ConnectionStatus, string> = {
  disconnected: 'Enter your auth token and click Connect to establish a WebSocket connection to the server.',
  connecting: 'Establishing connection to the server...',
  connected: 'Connected! Authenticating...',
  authenticated: '',
};

// Use: <p className="text-sm text-muted-foreground">{HELPER_TEXT[connectionStatus]}</p>
```

- [ ] **Step 3: Update DashboardHeader.tsx**

Replace inline status badge:

```typescript
// Before: (inline badge rendering)
<Badge variant="outline" className="flex items-center gap-2">
  <span className={cn('w-2 h-2 rounded-full', statusColor, 'animate-pulse')} />
  {statusText}
</Badge>

// After:
import { ConnectionStatusBadge } from './ui/ConnectionStatusBadge';
<ConnectionStatusBadge status={connectionStatus} />
```

Remove the local status color/text logic.

- [ ] **Step 4: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ui/ConnectionStatusBadge.tsx web/src/components/LoginPage.tsx web/src/components/DashboardHeader.tsx
git commit -m "refactor: extract ConnectionStatusBadge component

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Create RefreshButton Component

**Files:**
- Create: `web/src/components/ui/RefreshButton.tsx`
- Modify: `web/src/components/DashboardHeader.tsx`
- Modify: `web/src/components/SessionsSection.tsx`

- [ ] **Step 1: Create RefreshButton.tsx**

```typescript
// web/src/components/ui/RefreshButton.tsx
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

- [ ] **Step 2: Update DashboardHeader.tsx**

Replace inline refresh button:

```typescript
// Before:
<Button
  variant="outline"
  size="sm"
  onClick={fetchSessions}
  disabled={loadingAgents}
  className="h-8 w-8 p-0"
>
  <RefreshCw className={cn('h-4 w-4', loadingAgents && 'animate-spin')} />
</Button>

// After:
import { RefreshButton } from './ui/RefreshButton';
<RefreshButton onClick={fetchSessions} loading={loadingAgents} />
```

- [ ] **Step 3: Update SessionsSection.tsx**

Replace inline refresh button:

```typescript
// Before:
<Button
  variant="outline"
  size="sm"
  onClick={fetchSessions}
  className="h-8 w-8 p-0"
>
  <RefreshCw className="h-4 w-4" />
</Button>

// After:
import { RefreshButton } from './ui/RefreshButton';
<RefreshButton onClick={fetchSessions} />
```

- [ ] **Step 4: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ui/RefreshButton.tsx web/src/components/DashboardHeader.tsx web/src/components/SessionsSection.tsx
git commit -m "refactor: extract RefreshButton component

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 2: FileBrowser Complexity Reduction (#68)

### Task 8: Create useNewEntryForm Hook

**Files:**
- Create: `web/src/hooks/useNewEntryForm.ts`
- Modify: `web/src/components/FileBrowser.tsx`

- [ ] **Step 1: Create useNewEntryForm.ts**

```typescript
// web/src/hooks/useNewEntryForm.ts
import { useState, useCallback } from 'react';

/**
 * Group new file/folder form state.
 * Manages visibility of new file/folder inputs and the name field.
 */
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

- [ ] **Step 2: Update FileBrowser.tsx**

Replace the three useState calls:

```typescript
// Before:
const [showNewFile, setShowNewFile] = useState(false);
const [showNewFolder, setShowNewFolder] = useState(false);
const [newName, setNewName] = useState('');

// After:
import { useNewEntryForm } from '../hooks/useNewEntryForm';
const newEntryForm = useNewEntryForm();

// Update all references:
// showNewFile → newEntryForm.showNewFile
// setShowNewFile → newEntryForm.setShowNewFile
// showNewFolder → newEntryForm.showNewFolder
// setShowNewFolder → newEntryForm.setShowNewFolder
// newName → newEntryForm.newName
// setNewName → newEntryForm.setNewName
```

- [ ] **Step 3: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useNewEntryForm.ts web/src/components/FileBrowser.tsx
git commit -m "refactor: extract useNewEntryForm hook to reduce FileBrowser state

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Create useRenameState Hook

**Files:**
- Create: `web/src/hooks/useRenameState.ts`
- Modify: `web/src/components/FileBrowser.tsx`

- [ ] **Step 1: Create useRenameState.ts**

```typescript
// web/src/hooks/useRenameState.ts
import { useState, useCallback } from 'react';

/**
 * Group rename operation state.
 * Manages which file is being renamed and the new name value.
 */
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

- [ ] **Step 2: Update FileBrowser.tsx**

Replace the two useState calls and related logic:

```typescript
// Before:
const [renamingPath, setRenamingPath] = useState<string | null>(null);
const [renameValue, setRenameValue] = useState('');

// After:
import { useRenameState } from '../hooks/useRenameState';
const renameState = useRenameState();

// Update all references:
// renamingPath → renameState.renamingPath
// setRenamingPath → renameState.setRenamingPath
// renameValue → renameState.renameValue
// setRenameValue → renameState.setRenameValue

// Replace inline rename start/cancel logic:
// Before:
const handleStartRename = (path: string, name: string) => {
  setRenamingPath(path);
  setRenameValue(name);
};

// After:
// Use renameState.startRename and renameState.cancelRename directly
```

- [ ] **Step 3: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useRenameState.ts web/src/components/FileBrowser.tsx
git commit -m "refactor: extract useRenameState hook to reduce FileBrowser state

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Create useFileBrowserDialogs Hook

**Files:**
- Create: `web/src/hooks/useFileBrowserDialogs.ts`
- Modify: `web/src/components/FileBrowser.tsx`

- [ ] **Step 1: Create useFileBrowserDialogs.ts**

```typescript
// web/src/hooks/useFileBrowserDialogs.ts
import { useState } from 'react';
import type { FileEntry } from '../services/fileOps';

/**
 * Group dialog target state for FileBrowser.
 * Manages delete confirmation and large file warning dialogs.
 */
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

- [ ] **Step 2: Update FileBrowser.tsx**

Replace the two useState calls:

```typescript
// Before:
const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
const [largeFileTarget, setLargeFileTarget] = useState<FileEntry | null>(null);

// After:
import { useFileBrowserDialogs } from '../hooks/useFileBrowserDialogs';
const dialogs = useFileBrowserDialogs();

// Update all references:
// deleteTarget → dialogs.deleteTarget
// setDeleteTarget → dialogs.setDeleteTarget
// largeFileTarget → dialogs.largeFileTarget
// setLargeFileTarget → dialogs.setLargeFileTarget
```

- [ ] **Step 3: Consolidate create handlers**

Replace duplicate createFile/createFolder handlers with a shared handler:

```typescript
// Before: (two separate handlers with duplicated logic)
const handleCreateFile = async () => { ... };
const handleCreateFolder = async () => { ... };

// After:
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

- [ ] **Step 4: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useFileBrowserDialogs.ts web/src/components/FileBrowser.tsx
git commit -m "refactor: extract useFileBrowserDialogs hook and consolidate create handlers

Reduces FileBrowser from ~400 lines to ~250 lines.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Phase 3: Dashboard Architecture Simplification (#69)

### Task 11: Inline DashboardModals

**Files:**
- Modify: `web/src/components/Dashboard.tsx`
- Delete: `web/src/components/DashboardModals.tsx`

- [ ] **Step 1: Inline dialogs in Dashboard.tsx**

Replace the `<DashboardModals>` component with inline dialog rendering:

```typescript
// Before:
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

// After:
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

Add necessary imports at the top:
```typescript
import { AgentDetailPanel } from './AgentDetailPanel';
import { CreateSessionDialog } from './CreateSessionDialog';
import { KillConfirmDialog } from './KillConfirmDialog';
import { AttachDialog } from './env/AttachDialog';
```

Remove the import:
```typescript
// Remove: import { DashboardModals } from './DashboardModals';
```

- [ ] **Step 2: Delete DashboardModals.tsx**

```bash
rm web/src/components/DashboardModals.tsx
```

- [ ] **Step 3: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Dashboard.tsx web/src/components/DashboardModals.tsx
git commit -m "refactor: inline DashboardModals to eliminate pass-through component

DashboardModals was a pure pass-through with 13 props and no logic.
Dialogs are now rendered directly in Dashboard for better clarity.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Create TerminalLayout Component

**Files:**
- Create: `web/src/components/TerminalLayout.tsx`
- Modify: `web/src/components/TerminalView.tsx`

- [ ] **Step 1: Create TerminalLayout.tsx**

```typescript
// web/src/components/TerminalLayout.tsx
import type { BottomTab } from './BottomBar';
import { BottomBar } from './BottomBar';
import { FileTabs } from './FileTabs';
import { EnvPanel } from './env/EnvPanel';
import { TerminalToolbar } from './TerminalToolbar';
import type { FileOps } from '../services/fileOps';

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
  onTerminalReveal?: () => void;
}

/**
 * Shared layout for terminal view with optional file operations.
 * Eliminates duplication between fileOps and no-fileOps branches.
 */
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
  onTerminalReveal,
}: TerminalLayoutProps) {
  const envPanel = <EnvPanel sessionId={sessionId} />;
  const commandsPanel = (
    <TerminalToolbar sendText={sendText} disabled={toolbarDisabled} />
  );

  if (fileOps) {
    return (
      <FileTabs
        fileOps={fileOps}
        onTerminalReveal={onTerminalReveal}
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

- [ ] **Step 2: Update TerminalView.tsx**

Replace the duplicated layout logic:

```typescript
// Before: (large conditional block with duplicated BottomBar/EnvPanel/TerminalToolbar)
{fileOps ? (
  <FileTabs ... />
) : (
  <>
    <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
    <BottomBar ... />
  </>
)}

// After:
import { TerminalLayout } from './TerminalLayout';

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
  onTerminalReveal={() => terminalRef.current?.refit()}
/>
```

- [ ] **Step 3: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/components/TerminalLayout.tsx web/src/components/TerminalView.tsx
git commit -m "refactor: extract TerminalLayout to eliminate layout duplication

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Refactor BottomBar Tab Buttons

**Files:**
- Modify: `web/src/components/BottomBar.tsx`

- [ ] **Step 1: Refactor to use tab mapping**

Replace the three nearly-identical button elements with a mapped array:

```typescript
// Before: (three <button> elements with identical structure)
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

// After:
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

- [ ] **Step 2: Run tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 3: Commit**

```bash
git add web/src/components/BottomBar.tsx
git commit -m "refactor: use tab mapping in BottomBar to eliminate button duplication

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final Verification

### Task 14: Run Full Test Suite and Lint

- [ ] **Step 1: Run all tests**

```bash
cd web && npm test
```

Expected: All 423 tests pass

- [ ] **Step 2: Run lint**

```bash
cd web && npm run lint
```

Expected: 0 warnings, 0 errors

- [ ] **Step 3: Run TypeScript check**

```bash
cd web && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 4: Build production bundle**

```bash
cd web && npm run build
```

Expected: Successful build

- [ ] **Step 5: Verify line count reduction**

```bash
wc -l web/src/components/FileBrowser.tsx
```

Expected: ~250 lines (down from ~400)

- [ ] **Step 6: Final commit (if any cleanup needed)**

```bash
git status
# If clean, no commit needed
```

---

## Summary

**Total Tasks:** 14  
**Expected Duration:** 2-3 hours  
**Lines Removed:** ~200+  
**Components Deleted:** 1 (DashboardModals)  
**New Utilities:** 10 (3 lib/, 7 hooks/)  
**New Components:** 3 (ConnectionStatusBadge, RefreshButton, TerminalLayout)

**Success Criteria:**
- All 423 tests pass
- Lint passes with 0 warnings
- TypeScript check passes
- Production build succeeds
- FileBrowser reduced to ~250 lines
- No behavior changes

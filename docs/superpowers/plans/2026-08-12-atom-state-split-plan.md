# Atom State Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Split `atoms/terminal.ts` into 3 domain files, lift all remaining component-local state to atoms, convert `useAddressProbeCache` to atoms.

**Architecture:** `atoms/session.ts` + `atoms/connection.ts` + `atoms/probe.ts`. Components only consume atoms — zero state logic in components.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `atoms/session.ts` | **create** | session identity, attachInfo, addresses, UI prefs, action atoms |
| `atoms/connection.ts` | **create** | P2P state, state machine, lastResize, derived URL/mode |
| `atoms/probe.ts` | **create** | probe results cache + derived latencies |
| `atoms/index.ts` | **create** | re-export all atoms |
| `atoms/terminal.ts` | **delete** | split into 3 files above |
| `hooks/useProbePolling.ts` | **create** | periodic probe, writes probeResultsAtom |
| `hooks/useAddressProbeCache.ts` | **delete** | replaced by probeResultsAtom |
| `components/Dashboard.tsx` | modify | remove attachDialogSession useState |
| `components/TerminalView.tsx` | modify | update atom imports, remove local probeCache |
| `components/AddressSelector.tsx` | modify | read latencies from atom |
| `components/env/AttachDialog.tsx` | modify | read probe data from atom |
| `components/SessionDropdown.tsx` | modify | use attachDialogSessionAtom |
| `atoms/__tests__/session.test.ts` | **create** | session atom tests |
| `atoms/__tests__/connection.test.ts` | **create** | connection atom tests |
| `atoms/__tests__/probe.test.ts` | **create** | probe atom tests |

---

### Task 1: Create atoms/session.ts

**Files:**
- Create: `web/src/atoms/session.ts`

Move session-related atoms from `terminal.ts` and add UI state:

```typescript
// web/src/atoms/session.ts
import { atom } from 'jotai';
import type { AttachInfo, EnvFileRef, Session, ProbedAddress } from '../types';
import type { AttachChoice } from '../components/env/AttachDialog';

// ── Base ──
export const sessionIdAtom = atom('');
export const sessionNameAtom = atom('');
export const attachInfoAtom = atom<AttachInfo | null>(null);
export const orderedUrlsAtom = atom<string[]>([]);
export const manualOverrideAtom = atom<string | null>(null);
export const forcedRelayAtom = atom(false);
export const rendererAtom = atom<'webgl' | 'canvas'>('webgl');
export const envRefsAtom = atom<EnvFileRef[]>([]);

/** Currently open attach dialog session (shared between Dashboard & SessionDropdown). */
export const attachDialogSessionAtom = atom<Session | null>(null);

// ── Derived ──
export const agentIdAtom = atom((get) => get(sessionIdAtom).split(':')[0] || null);
export const addressesAtom = atom<ProbedAddress[]>((get) => get(attachInfoAtom)?.addresses ?? []);
export const hasActiveSessionAtom = atom((get) => get(sessionIdAtom) !== '');

// ── Actions ──
export const attachToSessionAtom = atom(
  null,
  (_get, set, payload: { session: Session; choice: AttachChoice; navigate: (path: string) => void }) => {
    const { session, choice, navigate } = payload;
    set(sessionIdAtom, session.session_id);
    set(sessionNameAtom, session.session_name);
    set(attachInfoAtom, choice.attachInfo);
    set(orderedUrlsAtom, choice.orderedUrls);
    set(rendererAtom, choice.renderer);
    set(envRefsAtom, choice.envRefs ?? []);
    set(manualOverrideAtom, choice.selectedUrl ?? null);
    set(forcedRelayAtom, false);
    // Import and write terminalSessionStateAtom from connection.ts
    const { terminalSessionStateAtom } = require('./connection');
    set(terminalSessionStateAtom, 'connecting' as const);
    navigate(`/terminal/${encodeURIComponent(session.session_id)}`);
  },
);

export const disconnectAtom = atom(
  null,
  (_get, set, navigate: (path: string) => void) => {
    set(sessionIdAtom, '');
    set(sessionNameAtom, '');
    set(attachInfoAtom, null);
    set(orderedUrlsAtom, []);
    set(manualOverrideAtom, null);
    set(forcedRelayAtom, false);
    set(envRefsAtom, []);
    set(attachDialogSessionAtom, null);
    // Import and write connection atoms
    const { p2pConnectionAtom, p2pStateAtom, terminalSessionStateAtom, lastResizeAtom } = require('./connection');
    set(p2pConnectionAtom, null);
    set(p2pStateAtom, 'disconnected' as const);
    set(terminalSessionStateAtom, 'idle' as const);
    set(lastResizeAtom, null);
    navigate('/');
  },
);

export const switchAddressAtom = atom(
  null,
  (_get, set, url: string | null) => {
    set(manualOverrideAtom, url);
    if (url !== null) {
      set(forcedRelayAtom, false);
      const { terminalSessionStateAtom } = require('./connection');
      set(terminalSessionStateAtom, 'connecting' as const);
    }
  },
);
```

Note: use proper `import` statements for the cross-file atom references, not `require`. Import from `./connection` at the top of the file.

- [ ] Run tests: `npx vitest run src/atoms/__tests__/session.test.ts`

- [ ] Commit

---

### Task 2: Create atoms/connection.ts

**Files:**
- Create: `web/src/atoms/connection.ts`

```typescript
// web/src/atoms/connection.ts
import { atom } from 'jotai';
import type { P2PConnection, ConnectionState } from '../hooks/useP2PConnection';
import { manualOverrideAtom, orderedUrlsAtom, forcedRelayAtom, attachInfoAtom } from './session';

// ── Base ──
export const p2pStateAtom = atom<ConnectionState>('disconnected');
export const p2pConnectionAtom = atom<P2PConnection | null>(null);
export const terminalSessionStateAtom = atom<
  'idle' | 'connecting' | 'connected' | 'attached' | 'reconnecting' | 'failed'
>('idle');
export const lastResizeAtom = atom<{ cols: number; rows: number } | null>(null);

// ── Derived ──
export const activeUrlAtom = atom<string | null>((get) => {
  if (get(forcedRelayAtom)) return null;
  return get(manualOverrideAtom) ?? get(orderedUrlsAtom)[0] ?? null;
});

export const effectiveModeAtom = atom<'p2p' | 'relay'>((get) => {
  if (get(forcedRelayAtom)) return 'relay';
  return get(attachInfoAtom)?.mode === 'p2p' ? 'p2p' : 'relay';
});

export const isSwitchingAtom = atom((get) =>
  get(manualOverrideAtom) !== null && get(p2pStateAtom) !== 'connected',
);
```

- [ ] Run tests: `npx vitest run src/atoms/__tests__/connection.test.ts`

- [ ] Commit

---

### Task 3: Create atoms/probe.ts + hooks/useProbePolling.ts

**Files:**
- Create: `web/src/atoms/probe.ts`
- Create: `web/src/hooks/useProbePolling.ts`

```typescript
// web/src/atoms/probe.ts
import { atom } from 'jotai';
import type { AgentProbe, AddressLatency } from '../types';
import { agentIdAtom } from './session';

export const probeResultsAtom = atom<Map<string, AgentProbe>>(new Map());

export const currentAgentLatenciesAtom = atom<AddressLatency[]>((get) => {
  const agentId = get(agentIdAtom);
  if (!agentId) return [];
  return get(probeResultsAtom).get(agentId)?.latencies ?? [];
});
```

```typescript
// web/src/hooks/useProbePolling.ts
import { useSetAtom } from 'jotai';
import { probeResultsAtom } from '../atoms/probe';
import type { Agent } from '../types';

const POLL_INTERVAL_MS = 5 * 60_000;

export function useProbePolling(agents: Agent[]) {
  const setProbe = useSetAtom(probeResultsAtom);
  // ... port the probe logic from useAddressProbeCache
}
```

- [ ] Run tests

- [ ] Commit

---

### Task 4: Create atoms/index.ts, delete terminal.ts, update all imports

**Files:**
- Create: `web/src/atoms/index.ts`
- Delete: `web/src/atoms/terminal.ts`
- Modify: all ~10 files that import from `../atoms/terminal`

- [ ] `grep -rn "from.*atoms/terminal" src/` — find all imports
- [ ] Replace every `from '../atoms/terminal'` with the correct new import:
  - session atoms → `from '../atoms/session'`
  - connection atoms → `from '../atoms/connection'`
  - probe atoms → `from '../atoms/probe'`
- [ ] Update `atoms/__tests__/terminal.test.ts` → move tests to session.test.ts, connection.test.ts

- [ ] Run full test suite: `npx vitest run`

- [ ] Commit

---

### Task 5: Migrate components — remove local state

**Files:**
- Modify: `web/src/components/Dashboard.tsx`
- Modify: `web/src/components/SessionDropdown.tsx`
- Modify: `web/src/components/AddressSelector.tsx`
- Modify: `web/src/components/env/AttachDialog.tsx`
- Modify: `web/src/components/TerminalView.tsx`

- [ ] Dashboard: `useState<Session | null>(null)` → `attachDialogSessionAtom`
- [ ] SessionDropdown: `attachTarget` → `attachDialogSessionAtom`
- [ ] SessionDropdown: `killTarget` stays local (ephemeral dialog state)
- [ ] AddressSelector: read `currentAgentLatenciesAtom` instead of `latencies` prop
- [ ] AttachDialog: read `probeResultsAtom` via `currentAgentLatenciesAtom`
- [ ] TerminalView: remove `probeCache`, use atoms

- [ ] Run full test suite

- [ ] Commit

---

### Task 6: Delete useAddressProbeCache.ts

**Files:**
- Delete: `web/src/hooks/useAddressProbeCache.ts`
- Delete: `web/src/hooks/__tests__/useAddressProbeCache.test.ts` (if exists)

- [ ] Verify no imports: `grep -rn "useAddressProbeCache" src/`
- [ ] Delete files
- [ ] Commit

---

### Task 7: Final verification

- [ ] Full lint: `npx eslint src/ --ext .ts,.tsx --max-warnings 0`
- [ ] Full type check: `npx tsc --noEmit`
- [ ] Full test: `npx vitest run`
- [ ] Push + CI

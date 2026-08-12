# Design Spec: Atom State Split

## Overview

Split the monolithic `atoms/terminal.ts` into 3 files by domain, move all remaining component-local state into atoms, and ensure components only consume/trigger state — never maintain state logic.

## Architecture

```
atoms/
  session.ts       ← session identity, attachInfo, addresses, route selection, UI prefs
  connection.ts    ← P2P connection object, connection state, lastResize, state machine
  probe.ts         ← probe results cache (Map<agentId, AgentProbe>)
  index.ts         ← re-exports for backward compat

hooks/
  useProbePolling.ts  ← periodic probe trigger (runs in Dashboard, writes probeResultsAtom)
```

### atoms/session.ts

```ts
// ── Base ──
sessionIdAtom:     string
sessionNameAtom:   string
attachInfoAtom:    AttachInfo | null
orderedUrlsAtom:   string[]
manualOverrideAtom: string | null
forcedRelayAtom:   boolean
rendererAtom:      'webgl' | 'canvas'
envRefsAtom:       EnvFileRef[]

// ── Derived (只读) ──
agentIdAtom:       string          // sessionId.split(':')[0]
addressesAtom:     ProbedAddress[] // attachInfo?.addresses ?? []
hasActiveSessionAtom: boolean      // !!sessionId
```

### atoms/connection.ts

```ts
// ── Base ──
p2pStateAtom:              ConnectionState
p2pConnectionAtom:         P2PConnection | null
terminalSessionStateAtom:  'idle' | 'connecting' | 'connected' | 'attached' | 'reconnecting' | 'failed'
lastResizeAtom:            {cols, rows} | null

// ── Derived (只读) ──
activeUrlAtom:     string | null  // manualOverride ?? orderedUrls[0], null if forcedRelay
effectiveModeAtom: 'p2p' | 'relay' // forcedRelay ? 'relay' : attachInfo?.mode ?? 'relay'
isSwitchingAtom:   boolean        // manualOverride !== null && p2pState !== 'connected'
```

### atoms/probe.ts

```ts
// ── Base ──
probeResultsAtom: Map<string, AgentProbe>  // agentId → { latencies, orderedUrls, probedAt }

// ── Derived (只读) ──
currentAgentLatenciesAtom: AddressLatency[]  // probeResults[agentId]?.latencies ?? []
```

## Component Changes

### Deleted local state:

| Component | Removed State | Replaced By |
|-----------|--------------|-------------|
| Dashboard | `attachDialogSession` (useState) | `attachDialogSessionAtom` in session.ts |
| TerminalView | `terminalHandle` (useState) | not an atom — keep as callback ref |
| TerminalView | `toolbarDisabled` (useState) | not an atom — derived from banner |
| SessionDropdown | `attachTarget`, `killTarget`, `searchQuery` | `attachDialogSessionAtom` (shared), keep `searchQuery` local |
| useAddressProbeCache | entire hook | `probeResultsAtom` + `useProbePolling` |

### Action atoms (keep in session.ts):

```ts
attachToSessionAtom   // writes session base atoms + starts state machine
disconnectAtom        // clears session + connection atoms
switchAddressAtom     // writes manualOverride + resets forcedRelay
```

## Data Flow

```
useProbePolling (Dashboard)
  → probes agents on mount + every 5min
  → writes probeResultsAtom

AttachDialog
  → reads probeResultsAtom → shows latency
  → requestAttach → writes attachInfoAtom
  → confirm → attachToSessionAtom → writes session atoms + navigates

AddressSelector
  → reads addressesAtom, currentAgentLatenciesAtom, activeUrlAtom
  → writes switchAddressAtom

Terminal
  → reads p2pConnectionAtom, terminalSessionStateAtom, sessionNameAtom
  → state machine effect drives protocol
```

## File Changes

| File | Action |
|------|--------|
| `atoms/terminal.ts` | delete (contents split into 3 files) |
| `atoms/session.ts` | create |
| `atoms/connection.ts` | create |
| `atoms/probe.ts` | create |
| `atoms/index.ts` | create (re-exports) |
| `hooks/useProbePolling.ts` | create |
| `hooks/useAddressProbeCache.ts` | delete |
| `components/Dashboard.tsx` | remove attachDialogSession useState, use attachDialogSessionAtom |
| `components/TerminalView.tsx` | update imports |
| `components/AddressSelector.tsx` | read latencies from atom instead of prop |
| `components/env/AttachDialog.tsx` | read latencies from atom instead of probeCache |
| `components/SessionDropdown.tsx` | use attachDialogSessionAtom instead of local state |
| all other atom consumers | update import paths |

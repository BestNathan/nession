# P2P Background Probe Fix — Design Spec

**Date:** 2026-08-11
**Status:** approved

## Problem

`useAddressProbeCache` is supposed to probe every online agent's P2P addresses
in the background on login so the attach dialog never blocks on latency testing.
It doesn't work: the initial `probeAll()` fires on mount when `agents` is still
`[]` (data hasn't loaded yet). The effect never re-runs because its callback
dependencies are stable. The first actual probe happens **5 minutes later** via
`setInterval`.

## Fix

Add a second `useEffect` keyed on the agent list's "probe-relevant fingerprint"
so the hook re-probes whenever the set of online agents or their addresses
changes — not just on the 5-minute timer.

**Fingerprint:** a stable string derived from `agents` that only changes when
an online agent's address list actually differs:
`<agent_id>:<status>:<address_urls_csv>` per agent, sorted, joined.

## Scope

- **Modify:** `web/src/hooks/useAddressProbeCache.ts` — add reactive probe trigger
- **Modify:** `web/src/hooks/__tests__/useAddressProbeCache.test.ts` — add test for late-arriving agents
- No server-side changes needed (server probing works correctly)

## Behavior

1. On mount: probe all online agents (existing behavior — works when agents are
   already loaded, e.g. on re-mount)
2. When agents list changes (new agent online, addresses change): probe only the
   **new or changed** agents to avoid redundant work
3. Every 5 minutes: re-probe all agents (existing behavior)
4. `refreshAgent` still forces a single-agent re-probe on demand

## Non-Goals

- Changing probe interval
- Changing what constitutes "reachable"
- Server-side probe changes
- UI changes

# P2P Background Probe Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `useAddressProbeCache` so it probes agent addresses immediately when agents load, not just on mount and every 5 minutes.

**Architecture:** Add a `useEffect` keyed on a fingerprint of the agent list so the hook re-probes when agents arrive or their addresses change. The fingerprint only reflects online agents with addresses, avoiding unnecessary re-probes on heartbeat-only changes.

**Tech Stack:** React, TypeScript, Vitest, @testing-library/react

---

### Task 1: Compute agent fingerprint and add reactive probe trigger

**Files:**
- Modify: `web/src/hooks/useAddressProbeCache.ts`

- [ ] **Step 1: Add `computeFingerprint` helper**

Add a pure function that derives a stable key from the agents list for use as an effect dependency:

```ts
/** Stable string that changes only when online agents or their addresses differ. */
function computeFingerprint(agents: Agent[]): string {
  return agents
    .filter((a) => a.status === 'online' && (a.addresses?.length ?? 0) > 0)
    .map((a) => {
      const urls = (a.addresses ?? []).map((addr) => addr.url).sort().join(',');
      return `${a.agent_id}:${a.status}:${urls}`;
    })
    .sort()
    .join('|');
}
```

Place it above the `useAddressProbeCache` function (module scope, no dependencies).

- [ ] **Step 2: Compute fingerprint in the hook and add reactive effect**

Inside `useAddressProbeCache`, after `probeAll` is defined:

```ts
const fingerprint = useMemo(() => computeFingerprint(agents), [agents]);

// Track previous fingerprint to identify which agents are genuinely new/changed.
const prevFingerprintRef = useRef<string>(fingerprint);

// Reactive probe: when agents arrive or addresses change, probe new/changed agents.
useEffect(() => {
  const prev = prevFingerprintRef.current;
  prevFingerprintRef.current = fingerprint;

  // Skip the mount event — the interval-driven probeAll() already covers that.
  // Only react to subsequent changes.
  if (prev === fingerprint) { return; }

  // Find agents that are new or changed since last fingerprint.
  const currentSet = new Map(
    agents
      .filter((a) => a.status === 'online' && (a.addresses?.length ?? 0) > 0)
      .map((a) => [a.agent_id, a] as const),
  );

  // Probe only genuinely new/changed agents — not all.
  for (const [id, a] of currentSet) {
    const cached = cacheRef.current.get(id);
    if (!cached) {
      void probeAgent(a);
    }
  }
}, [fingerprint, agents, probeAgent]);
```

- [ ] **Step 3: Add `cacheRef` for reading current cache inside effect without listing it as dep**

The reactive effect above reads the cache to skip already-probed agents. Add a ref mirroring the cache:

```ts
const cacheRef = useRef(cache);
cacheRef.current = cache;
```

Place this right after the `useState` for `cache`.

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useAddressProbeCache.ts
git commit -m "fix: trigger background P2P probe when agents load or addresses change"
```

---

### Task 2: Add test for late-arriving agents

**Files:**
- Modify: `web/src/hooks/__tests__/useAddressProbeCache.test.ts`

- [ ] **Step 1: Add test case — probes when agents arrive after mount**

```ts
it('probes agents that arrive after mount (reactive trigger)', async () => {
  const { testAddresses } = await import('../../services/addressSelection');
  const mock = testAddresses as ReturnType<typeof vi.fn>;

  // Start with empty agents (simulates pre-fetch state)
  const { result, rerender } = renderHook(
    ({ agents }) => useAddressProbeCache(agents),
    { initialProps: { agents: [] as Agent[] } },
  );

  // Flush the initial probe cycle — should probe nothing
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  const callsBefore = mock.mock.calls.length;

  // Agents arrive later (simulates fetchAgents response)
  rerender({ agents: [agent('a1', ['ws://x/ws'])] });

  // Flush the reactive probe
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });

  // Should have probed the newly-arrived agent
  expect(mock.mock.calls.length).toBeGreaterThan(callsBefore);
  expect(result.current.getProbe('a1')?.orderedUrls).toEqual(['ws://x/ws']);
});
```

- [ ] **Step 2: Run tests to verify**

```bash
cd web && npx vitest run src/hooks/__tests__/useAddressProbeCache.test.ts
```

Expected: 6 tests pass (5 existing + 1 new)

- [ ] **Step 3: Run full test suite**

```bash
cd web && npm test
```

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/__tests__/useAddressProbeCache.test.ts
git commit -m "test: verify background probe triggers on late-arriving agents"
```

---

### Task 3: Verify and deploy

- [ ] **Step 1: Run Rust tests**

```bash
cargo test
```

- [ ] **Step 2: Run web lint + type check**

```bash
cd web && npm run lint && npx tsc --noEmit
```

- [ ] **Step 3: Push and create PR**

```bash
git push -u origin feat/p2p-probe-fix
gh pr create --title "fix: trigger background P2P probe when agents load" --body "...
Closes #<ISSUE>"
```

- [ ] **Step 4: Enable auto-merge**

```bash
gh pr merge <PR> --auto --squash
```

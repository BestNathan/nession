# Agent Workspace · Current Session process discovery — interactive prototype (#2514)

[Requirement #2514](https://github.com/BestNathan/nession/issues/2514) · [Standalone HTML](index.html) · [Nession prototype center](https://bestnathan.github.io/nession/#/prototypes)

## Owner decision and supersession (2026-11-02)

**Question:** What belongs in the Agent capability while the user is already working in a Nession Session?

**Answer:** A compact Agent identity/connectivity summary, **the current Session only**, a single hierarchical process tree, and the selected process's command/resources. **No Session selector, other Session process trees, Pane/Window grouping, Pane IDs, or extra navigation tabs.** This supersedes the older published #2514 mock that showed Session → Pane → Process.

Tmux Pane/window/cgroup discovery remains an **internal backend attribution mechanism**, not a user-facing concept. The production transport/API is not redefined by this prototype. No process kill or quota action is introduced.

## Scenario / behavior contract

1. Open `index.html`; current Session is `nession-dev` on the default Linux Agent. The header is node identity + quiet status, with environment facts behind disclosure.
2. The **current Session's** process tree appears immediately. On desktop (wide viewport), the selected process inspector is adjacent to the tree; on a narrow/mobile viewport, the tree is the root and selecting a process enters a detail screen. **Back** preserves Session and PID selection.
3. Inspect `claude`: sanitized full command appears before CPU, RSS, threads, uptime and optional I/O. Toggle **仅本进程 / 含子进程**; aggregation follows **only real PPID descendants**. Selecting `worker.py` shows a *reparented* separate root, still visible through verified resource-domain membership but **not folded into Claude's subtree**.
4. Select `git`: expired CPU/RSS/I/O read as **不可用**, never zero. Select `worker.py`: copy uses only the already-sanitized command with `[REDACTED]`. On macOS, unsupported I/O is unavailable; CPU may validly exceed 100% of one logical core.
5. Use **MOCK SCENARIO**: Linux dedicated resource scope, Linux shared container fallback, macOS fallback, Agent offline, and **no current Session**. The last case must show an empty context rather than auto-choosing the Agent's other Session. The synthetic `infra` Session, with its `infra-private` process, is intentionally retained in fixture data but **never offered or rendered**.
6. Expand **发现依据与诊断** to read method, coverage and reason code. Refresh the simulated snapshot when online; on offline, Refresh is disabled and no process count is inferred. The footer Capsule remains Nession-owned and has no capability-specific navigation.
7. Test a wide Web viewport and narrow mobile width: list → detail → back, process selection, subtree switch, diagnostic disclosure, unavailable metrics and return to the current Session.

## Process and resource semantics

- Process identity in production uses PID **and start time**; deduplicate Session-wide membership without inventing parent-child edges. The mock fixture has unique PIDs and only illustrates the same hierarchical relationship.
- Resource scope toggles between **selected PID** and its **PPID descendants, inclusive of self**. A worker discovered through a detached/verified cgroup but with no PPID path must remain a separate root, not enter an unrelated PID's subtree.
- CPU utilization is percent of one logical CPU over an illustrative 5-second window; it can exceed 100%. RSS is resident memory in MiB, threads are counts, and I/O rates are KiB/s. Elapsed time always refers to the selected process and is not summable.
- Null/expired/unsupported fields are **unavailable**. A descendant aggregate with any missing member for a particular field is not reported as a complete numerical sum.
- Command-line arguments are synthetic, pre-sanitized and bounded; no raw argv reveal, environment inspection or dangerous process actions are offered. Copy, when browser permission permits, copies the same sanitized value.
- T+N and the 60s mini-curves are **mock values**, not real collection timestamps or an actual history store.

## Fidelity and verification

**Fidelity:** public-safe synthetic hostnames, commands, PIDs, statuses and resource readings. No requests to an Agent/Server, no actual tmux/systemd/OS probe, no real auth or persistent state. The desktop/mobile layout is an interactive design mock, not production React, shadcn, or a trusted acceptance receipt.

**Checks performed for 2026-11-02 revision:** JavaScript source parsed successfully; static checks passed for current-Session-only context, no Session/Pane selector or Pane UI, PPID forest, mobile detail/back state, redaction, unavailable values, five scenarios, and no other-Session fixture leakage in static markup. **No real browser interaction or E2E proof has been performed for this revision.** Do not reuse older 10/10 DOM smoke or Pages delivery evidence for the new revision.

**Browser verification still needed:** open actual page, test wide/mobile and keyboard focus, session-only context, selected PID, subtree totals, unknown metrics, copy errors, offline and no-current cases, and browser console. The public Pages preview is **unverified for the revised source until** the deployed `prototypes/manifest.json` references the latest prototype-branch source SHA and the direct HTML URL renders the new design. A Git commit alone is not publication.

## Open engineering questions (not UI blockers)

- Handling retained resource-domain membership for a background worker whose original tmux execution unit has already exited (the UI still never exposes Pane as a product concept).
- Which optional platform-specific metrics are worth providing and whether to persist trend history; no continuous polling is mandated here.
- Exposing process detail through other capabilities would require a separate design decision; Agent does not acquire navigation ownership of other Sessions.

## Publication delivery

Keep this directory on the single isolated orphan `prototype` branch and update both the root `README.md` catalog and `index.html` gallery. After pushing, the unprivileged **Prototype / Change Signal** may trigger the trusted main-owned **Deploy / Public Pages** workflow. Verify the exact published SHA in `prototypes/manifest.json`, compare the direct HTML response, then update #2514's immutable source pin and HTTPS publication evidence. Do not claim that a branch push or historical Pages run proves the new design is live.

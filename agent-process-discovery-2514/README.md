# Agent capability and Session process discovery — interactive prototype (#2514)

[Requirement #2514](https://github.com/BestNathan/nession/issues/2514) · [Standalone HTML](index.html) · [Pages prototype center](https://bestnathan.github.io/nession/#/prototypes)

## Decision and scope

**Question:** how should the existing Workspace **Agent** capability grow beyond node metadata to report runtime capabilities and show Session-owned processes without inventing a permanent Process tab or overclaiming cgroup support?

**Answer demonstrated:** the existing Agent capability entry opens a concise node overview; contextual Sessions & Processes drill down by Session and Pane; Diagnostics exposes evidence and fallback reasons. This is a design mock, not production UI.

## Walkthrough

1. Open `index.html` (no build/server required). The default Linux scenario has independent per-Pane tmux systemd scopes.
2. Click **查看进程** or **Sessions & Processes**; switch `nession-dev` and `infra`, inspect both Panes and select any process to view the attribution/evidence.
3. Select `worker.py` marked **reparented**; the mock includes it by verified scope membership despite PPID no longer leading to the original pane shell.
4. Use **MOCK SCENARIO** to switch to Linux shared-container cgroup (must reject shared scope and downgrade), macOS (no Linux cgroup, PPID and TTY association), and Agent Offline (unknown is **not zero**).
5. Open **能力诊断** to inspect reason codes, then return to Agent overview using tabs or the Agent capsule entry. Click **刷新** for a deterministic snapshot counter (offline refresh reports inability).
6. Repeat at desktop and a narrow mobile viewport.

## State and fidelity contract

- All processes, PIDs, hostnames, terminal versions, statuses and capabilities are synthetic public-safe fixtures. Time T+N is simulated and repeatable. No real system requests.
- **Mock**: interaction, mobile layout, runtime capability detection results, fallback reason, selected process, refresh, absent/offline states.
- **Not implemented**: real `tmux`/systemd/Linux/macOS discovery, API, authorization, persistence, instrumentation, E2E, killing/limiting processes, provider inference.
- Process count is a fixture count and not proof of a live Session. The label **complete** means the checked resource domain snapshot, not historic provenance.
- The mock uses a standalone visual approximation of the Nession Workspace and does not import production components/tokens or Pages application code.

## Static smoke checks

- Standalone HTML only; no external script/font/CDN/module dependencies.
- Document contains the four environment fixtures (`linux`, `shared`, `mac`, `offline`), Overview/Processes/Diagnostics views, focus/refresh/selected process handlers, mocked reparented worker, and visible source links injected by the publisher.
- Browser interaction verification / public HTTPS/manifest publication needs separate verification; source commit alone is not evidence the live Pages URL was updated.

## Open product decisions

- Whether the Process drill-down should also be surfaced in the Session capability (without duplicating Agent ownership).
- Long-running reparented worker visibility when a Pane has already exited: requires retained scope mappings, not just a fresh `list-panes` call.
- Which diagnostic details to expose on mobile without leaking private local paths or sensitive command arguments.

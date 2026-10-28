# Agent capability and Session process discovery — interactive prototype (#2514)

[Requirement #2514](https://github.com/BestNathan/nession/issues/2514) · [Standalone HTML](index.html) · [Pages prototype center](https://bestnathan.github.io/nession/#/prototypes)

## Decision and scope

**Question:** how should the existing Workspace **Agent** capability grow beyond node metadata to report runtime capabilities and show Session-owned processes without inventing a permanent Process tab or overclaiming cgroup support?

**Answer demonstrated:** the existing Agent capability entry opens a concise node overview; contextual Sessions & Processes drill down by Session and Pane; Diagnostics exposes evidence and fallback reasons. This is a design mock, not production UI.

## Walkthrough

1. Open `index.html` (no build/server required). The default Linux scenario has independent per-Pane tmux systemd scopes.
2. Click **查看进程** or **Sessions & Processes**; switch `nession-dev` and `infra`, inspect both Panes and select any process to inspect its **sanitized full command, sampled CPU, RSS, thread count, elapsed time, I/O rates and simulated 60s trends**, with provenance/Pane metadata demoted below.
3. Select `worker.py` marked **reparented**; the mock includes it by verified scope membership despite PPID no longer leading to the original pane shell.
4. Select `claude` and toggle **仅本进程 / 含子进程**. Aggregation walks PPID descendants only and excludes reparented `worker.py` from the Claude PID tree. Select `git`: missing/expired resource fields must read **不可用**, not zero. Select `worker.py`: copied command must contain `[REDACTED]`, never a secret. On macOS, I/O rates display unavailable.
5. Use **MOCK SCENARIO** to switch to Linux shared-container cgroup (must reject shared scope and downgrade), macOS (no Linux cgroup, PPID and TTY association), and Agent Offline (unknown is **not zero**).
6. Open **能力诊断** to inspect reason codes, then return to Agent overview using tabs or the Agent capsule entry. Click **刷新** for a deterministic snapshot counter (offline refresh reports inability).
7. Repeat at desktop and a narrow mobile viewport.

## Command and resource observation contract

- Process detail prioritizes **command line (sanitized argv) → sampled CPU / resident memory (RSS) → thread/uptime/I/O → process identity and membership evidence**. No kill, signals, raw environment or secret reveal.
- **CPU:** per-process CPU utilization over an explicit 5-second sampling interval, in percent of **one logical CPU** (multithreaded usage may exceed 100%). **Memory:** RSS in MiB (not virtual memory nor cgroup memory usage). **I/O:** read/write rates in KiB/s, optional and unavailable on unsupported OS / permissions. Threads are a sampled count; elapsed runtime is not a summable metric.
- **Aggregation:** current selected PID vs *PPID descendants*, including the selected PID; excludes cgroup-only reparented process from that PID's ancestry even when it is present in the Pane. Deduplicate descendants by PID + start-time identity in production. If any required metric is missing, aggregated metric is `Unavailable`, **never a partial total misleadingly labeled complete**.
- **Sample semantics:** timestamp, sampling interval, freshness/collection error and per-field support travel with the snapshot; CLI args are bounded and redacted before transport and then copying uses the same sanitized string. No unfiltered command-line reveal toggle.
- **Mock limitation:** metrics, elapsed time and last-minute sparklines are deterministic synthetic fixture values; T+N is **not wall-clock telemetry**. No real sampling, history store, or live updates.

## State and fidelity contract

- All processes, PIDs, hostnames, terminal versions, statuses and capabilities are synthetic public-safe fixtures. Time T+N is simulated and repeatable. No real system requests.
- **Mock**: interaction, mobile layout, runtime capability detection results, fallback reason, selected process, refresh, absent/offline states, command/resource emphasis, subtree resource toggle, unavailable metrics, copy of only sanitized argv.
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
- Which advanced diagnostic fields are worth exposing on mobile; command/resource summary remains primary and no private raw argv is shown.
- Whether process-level trend history should be persisted (not required for initial snapshot API); the mock sparklines do not define history collection policy.

## Publication delivery

This static mock is authored on the isolated `prototype` branch and published by the trusted main-owned [Deploy / Public Pages](https://github.com/BestNathan/nession/actions/workflows/deploy-pages.yml) workflow. The read-only `Prototype / Change Signal` runs on ordinary source pushes and triggers a constrained `workflow_run` consumer after [#2518](https://github.com/BestNathan/nession/pull/2518). The live preview must be verified by the deployed `prototypes/manifest.json` source SHA and the standalone HTML response; a source commit is not itself proof of HTTPS publication. This section was added as the end-to-end event-bridge verification source change for [#2519](https://github.com/BestNathan/nession/issues/2519).

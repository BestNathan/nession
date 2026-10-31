# Session process discovery

Status: **delivered for #2514**. Canonical owner of the read-only process
discovery contract between the Agent's Session domain, the Server and the Web
Agent Workspace.

Related owners:

- [`session-tmux-sdk-ownership.md`](session-tmux-sdk-ownership.md) — the
  Session/tmux ownership chain this feature extends; Pane identity is
  tmux-native and stays in `nession-tmux`.
- [`../design/design-system/patterns/agent-detail.md`](../design/design-system/patterns/agent-detail.md)
  — the Agent detail view this capability deepens.
- [`protocol.md`](protocol.md) — the Protocol Kernel model; the snapshot is a
  versioned contract, not a private wire convention.

## What the feature is

A user can open the existing **Agent** capability, select one of that Agent's
Sessions, and read a bounded, point-in-time snapshot of the processes that
belong to the Session's Panes. It is an observation. There is no process
control, no kill/signal action, no cgroup creation, no resource quota, no
retained history and no raw-environment reveal.

The answer is produced by the Agent because only the Agent can combine tmux
Pane identity with node-local OS observation. The Server authorizes and relays;
it never enumerates processes. The Web renders facts; it never probes the OS.

```text
Web Agent Workspace
  -> server.session.processes            (authenticated browser request)
     -> agent.session.processes          (Server -> Session's Agent)
        -> Agent Session domain process discovery
           -> nession-tmux Pane identity
           -> Linux cgroup v2 / macOS libproc / process-tree fallback
```

## Pane identity is tmux-native

`TmuxOps::list_panes` returns one row per Session→Window membership with
`session_id`, `session_name`, `window_id`, `window_index`, `window_name`,
`pane_id`, `pane_index`, `pane_pid`, `pane_tty` and `window_linked`.

- A **linked Window** produces one row per Session that links it, all with the
  same `pane_id`. Grouping by `pane_id` yields one Pane and one process list;
  the Pane keeps every `session_ids`/`session_names` membership.
- `pane_pid` and `pane_tty` are read fresh for every snapshot. A respawned Pane
  is never represented by a cached root.

## Two discovery methods, and what each proves

### Verified dedicated per-Pane cgroup (Linux)

tmux may create a systemd scope named `tmux-spawn-<uuid>.scope` per Pane. The
Agent accepts that scope only when all of the following hold **at query time**:

1. `/proc/<pane_pid>/cgroup` names a unified (`0::`) path whose last component
   starts with `tmux-spawn-` and ends with `.scope`;
2. `/sys/fs/cgroup/<path>` exists and is readable;
3. recursively reading `cgroup.procs` (bounded by depth and count) finds the
   Pane's root PID;
4. the Agent's own PID is **not** in that membership;
5. no other Pane in the same snapshot claims the same scope path.

Failure of any check is a reason code, not a silent fallback. cgroup v1 is not
treated as dedicated scope.

Coverage `complete` means complete for **the observed dedicated resource domain
at snapshot time** — not proof of every process the Session ever launched. A
PPID descendant found outside the scope is included (it is still attributable
to the Pane), and the Pane becomes `partial` with `process_outside_cgroup`.

### Process enumeration + PID/PPID recursion

This is the fallback on every platform and the only method on macOS:

- Linux: `/proc/<pid>/stat` (PPID, PGID, SID, TTY, CPU ticks, start ticks,
  threads, RSS), `/proc/<pid>/cmdline`, `/proc/<pid>/exe`, `/proc/<pid>/io`.
- macOS: `proc_listpids` + `proc_pidinfo` (`PROC_PIDTBSDINFO`,
  `PROC_PIDTASKINFO`), `proc_pid_rusage` (`RUSAGE_INFO_V4`), `proc_pidpath`,
  `devname` and `KERN_PROCARGS2`. The `KERN_PROCARGS2` parser stops after the
  declared `argc` argv entries and never reads the environment that follows.

Coverage is always `partial`: a daemonized or adopted worker that left the tree
is not discoverable. SID, PGID and TTY travel on each process as
**lower-confidence association evidence** and never upgrade the coverage claim.

## Wire truth

`ProcessSnapshot` carries `snapshot_at_ms`, `platform`, the distinct `methods`,
per-Pane `method`/`coverage`/`reason_codes`, the applied `limits`, and
`truncated`.

Each `DiscoveredProcess` carries:

- identity: `pid`, `parent_pid`, `start_time_ms` (wall-clock epoch
  milliseconds; PID alone is not identity because PIDs are reused);
- evidence: `tty`, `sid`, `pgid`;
- `executable` (bounded) and the sanitized, bounded `command` plus
  `command_state`/`command_reason`, `redacted` and `truncated`;
- `cpu_percent`, `rss_mib`, `threads`, `elapsed_ms`, `io_read_kib_per_s` and
  `io_write_kib_per_s`, each a `ProcessMetric { value?, state, reason? }`.

Metric states are `sampled | unsupported | denied | unknown | stale`. **Zero is
a sampled value; it is never used for "we could not read it".** A process that
exits during the sampling window is `stale`, not zero.

Semantics:

| Field | Unit and meaning |
|---|---|
| `cpu_percent` | Percent of **one logical CPU**, sampled over `limits.cpu_window_ms`; values above 100 are valid multi-core usage |
| `rss_mib` | Resident set size in MiB; not virtual size and not cgroup memory |
| `threads` | Sampled thread count |
| `elapsed_ms` | Wall-clock lifetime at snapshot time; not summable |
| `io_*_kib_per_s` | Read/write throughput over the same sampling window |

Missing or denied fields remain unknown; they are never summed as zero.

## Bounds

One snapshot is bounded by 512 processes, 64 Panes, recursion depth 32, 32
display argv entries / 512 command bytes, and a 150 ms CPU/I-O sampling window.
A bound that is reached sets `truncated` and a `process_limit_reached` reason on
the affected Pane. Enumeration is on demand; there is no continuous polling.

## Redaction and security

Command line arguments routinely carry credentials. Sanitization happens in the
Agent **before** the snapshot crosses the Agent→Server transport:

- a flag whose name names a secret consumes the next argument (`--token value`);
- `--name=value` and `NAME=value` lose the value for sensitive names;
- URL userinfo (`scheme://user:pass@host`) is replaced;
- query parameters with sensitive names lose their values;
- `Authorization:` and `Bearer …` lose everything after the marker;
- the display is bounded; `redacted` and `truncated` say which happened.

The environment is never read. The Web Copy affordance copies only the
sanitized display string; there is no raw-argv reveal endpoint. Visibility is
scoped to an authenticated browser requesting a Session on that Agent, and the
Server forwards only the Session name.

Discovery failure degrades the snapshot only: it cannot block terminal
creation, attach, detach, input or output recovery. A missing Pane root is
`unavailable`; an unreadable process table is `unavailable`; an unreadable
command is `denied`, not an empty command.

## Pane lifecycle and known limitations

- Every snapshot re-reads Pane identity; `new-window`, `split-window`,
  `respawn-pane`, rename/link/unlink and Pane exit are reflected on the next
  read.
- Linked Windows are deduplicated by `pane_id`; memberships stay many-to-many.
- A Pane whose root process is gone is `unavailable`, never an empty tree.
- **Not claimed:** retained scope/orphan tracking after a Pane has exited. That
  needs persisted evidence and is outside this stateless phase; the limitation
  is stated rather than inferred.
- **Not claimed:** process history/trend storage, auto-kill, signals, resource
  limits or quotas.

## Verification owners

- `crates/nession-agent/src/session/process_discovery/` — unit tests for cgroup
  scope recognition/membership/shared rejection, PPID boundaries, budgets,
  metric states, redaction, and a real isolated tmux Session.
- `crates/nession-tmux/src/ops.rs` — Pane rows and linked-Window memberships.
- `crates/nession-server/src/server/handler/tests/server_session_processes_v1.rs`
  — authentication, scoping, relay and refusal behavior.
- `crates/nession-protocol/src/contracts/session/tests.rs` — snapshot round
  trip and refusal discrimination.
- `web/src/product/agent/` — tree, subtree aggregation, inspector rendering,
  copy and mobile layout.
- `e2e/tests/browser/agent-process-discovery.spec.ts` — real full-stack
  regression; `e2e/acceptance/cases/2514/` — per-SC acceptance Cases.

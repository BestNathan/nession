# Sandbox policy and execution isolation

Status: **V1 delivered in source for #2681**, with the context capability and
existing-Session Enter added by #3124 (on-demand, Pane-scoped execution; not
whole-Session enforcement). Real Linux/macOS proof is bound to the Acceptance
Cases under `e2e/acceptance/cases/2681/` and `e2e/acceptance/cases/3124/`;
nothing in this document is evidence that a particular runner installed a
mechanism.

This is the canonical current-architecture owner for Sandbox behaviour. The
product decision (what V1 promises and explicitly does not) remains Requirement
[#2681](https://github.com/BestNathan/nession/issues/2681); the path-local
engineering rules are [crates/nession-sandbox/AGENTS.md](../../crates/nession-sandbox/AGENTS.md).

## Ownership chain

```text
SessionService / SessionManager (Session lifecycle, optional policy binding)
  -> nession-sandbox (compile/probe/prepare/verify/cleanup/reconcile)
       -> Linux: Bubblewrap mounts/namespaces + delegated cgroup v2 + seccomp
       -> macOS: Seatbelt profile for the capabilities its probe verified
  -> nession-tmux (generic tmux grammar)
       -> shared private tmux server -> Pane -> trusted launcher -> bridge -> shell
```

The shared tmux server, the Agent and Native Sessions never enter an execution
domain. `nession-tmux` receives only an explicit argv (`NewSession.command`);
it does not know what a sandbox is. `nession-sandbox` does not create tmux
objects, own attach state or mutate Session environment bindings (#170).

## Policy contract

The versioned shape lives in the Protocol Kernel:
`nession-protocol/src/contracts/sandbox/v1.rs`. Every struct refuses unknown
fields, so an unrecognised key fails at parse time, before any host resource
exists.

| Dimension | Meaning |
|---|---|
| `filesystem.access.read/write` | Visible host paths. An explicit policy hides every other host path. Write implies visible; listed Unix sockets still obey their own permissions. |
| `network.mode` | `allow` inherits host networking; `deny` blocks external and host-local IP networking; `restricted` is default-deny with Domain/IP/Port allow/deny rules enforced by the host-side proxy. |
| `network.egress` | Only for `restricted`. Exact host or IP with optional port; leading `*.` matches strict subdomains; deny wins. `private_network: deny` and `ingress: deny` are the only V1 values and are always in force. |
| `process.linux_namespaces` | Direct Linux PID/IPC/User/UTS/Cgroup namespace requests. Mount and network namespaces are owned by `filesystem`/`network`. Unsupported on macOS. |
| `resource.cgroup_v2` | Allowlisted native control files and values: `memory.max`, `cpu.max`, `pids.max`, `memory.oom.group`. Unsupported on macOS. |
| `syscall.seccomp.profile` | The pinned `nession-interactive-v1` profile. Unsupported on macOS. |
| `enforcement` | Only `required`: an explicitly requested guarantee that cannot be installed refuses the launch. |

Absence of a dimension adds no user-requested constraint in that dimension.
Backend safety prerequisites still apply (next section). `version` is `1`;
any other version is `UnsupportedPolicy`, never interpreted as v1.

## Backend baseline (all executions)

These are safety/executability prerequisites, not additional policy:

- mount, user, PID, IPC and UTS namespaces always;
- the pinned seccomp profile always, including the `ioctl(TIOCSTI)` argument
  check (so the profile is present even when `syscall.seccomp` is not asked
  for);
- `--cap-drop ALL` and Bubblewrap's no-new-privs setup;
- no inherited `TMUX`/`TMUX_PANE`, SSH agent, D-Bus or `XDG_RUNTIME_DIR`
  environment; the private tmux socket and Agent state are masked (or the
  policy is refused if it would expose them);
- a private `/tmp` tmpfs when `/tmp` is not visible;
- merged-`/usr` symlinks (`/bin`, `/sbin`, `/lib`, `/lib64`) when they resolve
  into a visible path.

## Launch barrier

1. `prepare` compiles the policy, probes the host, creates only owned
   resources (execution cgroup, per-execution channel socket, seccomp profile,
   durable record) and builds the launcher argv.
2. The trusted `/bin/sh` launcher enrolls its own PID in the execution cgroup,
   opens the profile as FD 3 and `exec`s Bubblewrap. It evaluates only `$$`;
   no policy string is interpolated into shell code.
3. Bubblewrap applies namespaces, mounts and the seccomp filter, then runs the
   bridge (a hidden subcommand of the Agent binary) inside the new PID
   namespace. Bubblewrap's own init may hold in-namespace PID 1 (measured with
   bubblewrap 0.8); the bridge reaps its descendants and the host verifies the
   namespace identity, not a PID number.
4. The bridge reports `/proc/self/ns/*`, `/proc/self/cgroup`, `Seccomp` and
   `NoNewPrivs`, plus the result of the filesystem probes, and **waits**.
5. The Agent authenticates the channel peer (`SO_PEERCRED` + descendant of the
   Pane process + cgroup membership), compares the facts with its own
   observation and only then writes `GO`.
6. The bridge starts the user's shell, forwards HUP/TERM/INT/QUIT and reaps
   orphans. A refused launch (`DENY`, missing peer, failed check) runs no user
   code.

## Restricted network

The bridge listens on sandbox-local `127.0.0.1:3128` and pipes each connection
to the per-execution Unix channel. The host proxy speaks SOCKS5 and HTTP
`CONNECT` (plain HTTP proxy requests are not supported). It:

- authorizes the target against the parsed allow/deny sets;
- resolves the name once, rejects loopback/private/link-local/metadata
  addresses (including IPv4-mapped forms), and connects to the validated
  address — no second resolution between check and connect;
- accepts a connection only when `SO_PEERCRED` identifies the execution's
  bridge PID. A sandbox process that finds the socket cannot borrow another
  execution's policy.

`ALL_PROXY`/`HTTPS_PROXY` are convenience hints. The network namespace and the
host proxy are the enforcement boundary.

## Resource: cgroup v2 delegation and cleanup

The cgroup v2 default root is `<Agent cgroup>/nession`. Creating an execution
group there requires the Agent's own cgroup to be a delegated root — a cgroup
with controllers available and **no processes of its own**, because the kernel
forbids a cgroup from both hosting processes and enabling domain controllers in
its `subtree_control`. A systemd `Delegate=yes` service or a Pod that places
the Agent in a leaf satisfies this; a plain container whose root cgroup hosts
PID 1 does not. Operators can point `[sandbox] cgroup_root` at a delegated
sibling. The backend probes rather than assumes: an unavailable delegation
reports `UnsupportedPolicy(resource.cgroup_v2)` and the create is refused.

## Deployment packaging and host prerequisites

The Agent image carries the `bubblewrap` launcher (`Dockerfile.agent` and
`Dockerfile.agent.prebuilt`), but the image alone is not a sandbox-capable host.
The deployment must also provide, and the probe must measure:

- unprivileged user namespaces (kernel and LSM policy permitting `unshare` and
  Bubblewrap's baseline namespaces);
- a writable cgroup v2 subtree with the requested controllers delegated, mapped
  at the same **kernel-relative** path configured in `[sandbox] cgroup_root`;
- the pinned seccomp/no-new-privileges path (the bridge installs its own filter;
  the surrounding container profile must not block it).

The container entrypoint projects operator configuration into `[sandbox]`:
`AGENT_SANDBOX_ENABLED` (master switch; when false, every explicit policy
request is refused but Native Sessions are unaffected), and optional
`AGENT_SANDBOX_BUBBLEWRAP_PATH`, `AGENT_SANDBOX_CGROUP_ROOT` and
`AGENT_SANDBOX_STATE_DIR`. A Pod whose `/sys/fs/cgroup` is read-only, or whose
own cgroup hosts processes, still fails closed at policy validation; it does not
silently degrade to Native. The acceptance lane measures the same capabilities
and reports Pending with the measured prerequisite when a runner lacks them.

## Context capability and existing-Session Enter (#3124)

Sandbox is a Session-context **capability**, not a host monitor. The subject is
the selected Session's **active Pane**:

```text
active Pane -> inside  : verified Nession-managed execution for THIS Pane
             -> outside : a Native Pane; Enter may be eligible
             -> unknown : identity/instance/execution not provable
```

`server.session.sandbox.context` reads the Agent's observation; the Agent
resolves the active Pane itself (`window_active` + `pane_active` on its private
tmux server), matches a tracked execution by exact `pane_id` (or, for a
pre-#3124 record, by the recorded root PID), and requires the Session's durable
`instance_id` to match. A same-named recreation therefore never inherits an
older execution, and an available backend never by itself produces `inside`.

`server.session.sandbox.preflight` validates the Web-safe draft on the Agent
without creating resources: compilation, working-directory/host-path checks and
the measured host-capability validation. `server.session.sandbox.enter` is the
single explicit mutation:

1. it re-reads the context and requires the preflight's opaque `generation` to
   still describe the same Pane/instance/execution;
2. it re-probes the host through `prepare` (the preflight is a hint, never a
   reservation);
3. `new-window -d` starts the trusted launcher in the **same logical Session**;
4. the launch barrier must verify before focus moves (`select-window`), so the
   original Native Pane is never written to and stays focused on failure;
5. a failed verification removes exactly the Window this attempt created and
   releases its owned resources. A repeated client `enter_id` replays the
   completed outcome instead of launching again.

The original Native Pane and the new Sandbox Pane are siblings. Return to
Native is a **focus switch**; the Sandbox execution keeps running. The Shell's
exit closes its Window, and the Pane-keyed reaper releases the record/cgroup.
Terminating a Sandbox execution is a separate lifecycle action, not a side
effect of returning.

### The Web-safe draft is a projection, not a second policy

The editor model (`SandboxPolicyDraft`) cannot carry the canonical dotted
cgroup keys under the generated-binding naming rules. Resource/Syscall are
therefore typed `{key, value}` rows that start empty. `nession-sandbox`
materializes them into `resource.cgroup_v2` / `syscall.seccomp`, validating
unknown, duplicate, blank and malformed rows with field-level errors, and
**omits an empty group** rather than sending `{}`. `compile` and the launch
barrier remain the only policy authorities. The Agent's capability catalog
(`resource_fields`, `syscall_fields`, `probe_generation`) is measured from its
real delegated child cgroup and profile registry; it feeds UI suggestions, and
stale probes are revalidated on preflight/Enter.

The inside view shows the execution's **observed normalized policy**, verified
mechanisms, warnings, execution/PID identity and its Pane-only scope. The
normalized policy is persisted in the durable execution record, so an Agent
restart can still answer it; a digest alone cannot reconstruct settings.

## Lifecycle and reconciliation

Each execution has a durable record under the Agent sandbox state directory
(execution id, Session name and instance id, tmux `pane_id`/`window_id`, the
observed normalized policy and verified mechanisms, backend, digest, cgroup
path, restricted flag, and the preserved Native Pane for an Enter). Cleanup
when the Pane disappears releases the cgroup (`cgroup.kill` only inside that
owned directory), closes the channel socket and removes the record/directory. A
failed cleanup keeps the record for retry.

The Agent reaper polls tmux Panes; a successful snapshot that lacks a tracked
`pane_id` triggers cleanup even while the Session name lives. A pre-#3124
record without a Pane identity falls back to Session liveness. At startup,
records are reconciled against the live Pane set, so a previous Agent process
cannot silently orphan resources and cannot cross-kill unrelated processes.
Restricted proxying does not survive the Agent process itself: the Pane and its
cgroup do, but the host proxy listener is recreated only for new executions.
This limitation is recorded, not claimed away.

## macOS: exactly what was verified

The macOS probe executes real allow/deny fixtures under `sandbox-exec`:

- `(deny network*)` blocks a connection the control run makes — **verified**;
- path allow-lists are not expressible with the measured compiler (the
  `deny … (require-not (subpath …))` form aborts), so `filesystem.access` is
  rejected with `UnsupportedPolicy` rather than approximated;
- `process.linux_namespaces`, `resource.cgroup_v2` and `syscall.seccomp` are
  rejected as Linux-native. `setrlimit` is not treated as cgroup v2.

## Known limits (V1)

- Not whole-Session enforcement: tmux server `run-shell`, other new-window/split
  command overrides and the shared control plane remain outside a Pane's
  execution domain. Enter isolates one new Pane; it does not convert the
  existing Native Pane or cover future Panes.
- No OCI image/rootfs, layer store, VM or ingress port publication.
- No HTTPS MITM, URL-path/method filtering, payload inspection or DLP.
- An allowed host/port can still exfiltrate data; the policy authorizes
  destinations, not content.
- Parent Pod/systemd cgroup limits can fire first; a per-execution limit is not
  host-wide immunity.
- Filesystem policy paths must be absolute, normalized and canonical on the
  host; a symlinked path is refused (name the canonical target).

## Enforcement and proof

| Invariant | Owner |
|---|---|
| Policy shape and unknown-key refusal | `crates/nession-protocol/src/contracts/sandbox/v1.rs` + protocol Gates |
| Validation, capability probing, no fallback | `crates/nession-sandbox/src/policy.rs`, `capabilities.rs` |
| Launcher argv, masking, seccomp baseline | `crates/nession-sandbox/src/linux/bwrap.rs`, `linux/seccomp.rs` |
| Cgroup delegation, limits and cleanup | `crates/nession-sandbox/src/linux/cgroup.rs` |
| Launch barrier and proxy identity | `crates/nession-sandbox/src/linux/channel.rs`, `src/bridge.rs` |
| Context snapshot, generation and Enter idempotency | `crates/nession-agent/src/tmux/sandbox_context.rs`, `crates/nession-server/src/server/handler/server_session_sandbox_*_v1.rs` |
| Draft rows → canonical policy, catalog | `crates/nession-sandbox/src/draft.rs`, `capabilities.rs` |
| Owned-resource reconciliation (by Pane) | `crates/nession-sandbox/src/exec.rs`, `crates/nession-agent/src/sandbox_runtime.rs` |
| Real Linux behaviour | `crates/nession-sandbox/tests/linux_runtime.rs` and `e2e/acceptance/cases/2681/` |
| Existing-Session Enter and active-Pane context | `e2e/acceptance/cases/3124/` (real Server + Agent), `e2e/tests/browser/sandbox-workspace-capability.spec.ts` |
| macOS verified scope | `crates/nession-sandbox/src/macos/` (probe tests run on macOS) |

## References

- #2681 — normative Requirement and Acceptance Plan (create-time V1).
- [#3124](https://github.com/BestNathan/nession/issues/3124) — context
  capability, policy editor and existing-Session Enter.
- [#2469](session-tmux-sdk-ownership.md) — Session/tmux ownership.
- [#2514](agent-process-discovery.md) — read-only process discovery.
- [#170](session-env-binding.md) — independent Session Environment Binding.
- [#1286](https://github.com/BestNathan/nession/issues/1286) — the historical
  Agent-wide OOM observation; the on-demand sandbox is not a complete fix for
  every Native Session.
- [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html),
  [seccomp](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html),
  [Bubblewrap](https://github.com/containers/bubblewrap) — mechanism semantics,
  not evidence that Nession runs them on a given host.

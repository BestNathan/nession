# Sandbox policy and execution isolation

Status: **V1 delivered in source for #2681**, with the context capability and
existing-Session Enter added by #3124, the prepared EROFS root composition
added by #3024, and Server-owned image composition on existing-Session Enter
added by #3181 (on-demand, Pane-scoped execution; not whole-Session
enforcement). Real Linux/macOS proof is bound to the Acceptance Cases under
`e2e/acceptance/cases/2681/`, `e2e/acceptance/cases/3124/`,
`e2e/acceptance/cases/3024/` and `e2e/acceptance/cases/3181/`; nothing in this
document is evidence that a particular runner installed a mechanism.

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

Server-owned images enter this chain only through the Image Manager: the Server
mints a scoped bearer grant per selected digest, the Agent verifies and caches
the bytes, and `nession-sandbox` receives local, already-prepared EROFS paths
inside its authorized image root. No client-supplied host path or URL crosses
that boundary.

## Policy contract

The versioned shape lives in the Protocol Kernel:
`nession-protocol/src/contracts/sandbox/v1.rs`. Named-field structs refuse
unknown fields, so an unrecognised key fails at parse time, before any host
resource exists. `resource.cgroup_v2` is deliberately the one open-keyed map:
its keys are kernel control-file basenames, validated by the generic naming
rule in `nession-sandbox/src/cgroup_file.rs` and ultimately by the kernel.

| Dimension | Meaning |
|---|---|
| `filesystem.access.read/write` | Visible host paths. An explicit policy hides every other host path. Write implies visible; listed Unix sockets still obey their own permissions. |
| `filesystem.composition` | A prepared EROFS root: Base Runtime at `/`, Project source image + bounded writable overlay at `/workspace`, read-only toolchains at `/opt/<name>`. Mutually exclusive with `filesystem.access`. See [#3024 composition](#prepared-erofs-root-composition-3024). |
| `network.mode` | `allow` inherits host networking; `deny` blocks external and host-local IP networking; `restricted` is default-deny with Domain/IP/Port allow/deny rules enforced by the host-side proxy. |
| `network.egress` | Only for `restricted`. Exact host or IP with optional port; leading `*.` matches strict subdomains; deny wins. `private_network: deny` and `ingress: deny` are the only V1 values and are always in force. |
| `process.linux_namespaces` | Direct Linux PID/IPC/User/UTS/Cgroup namespace requests. Mount and network namespaces are owned by `filesystem`/`network`. Unsupported on macOS. |
| `resource.cgroup_v2` | A native map of control-file basename to raw text value (`cpu.weight`, `memory.high`, `io.max`, ...). The Agent discovers the declarative files its delegated child exposes; the kernel validates each value. No per-resource application parsers or fixed four-key allowlist. Unsupported on macOS. See [#3141](#native-cgroup-v2-resource-passthrough-3141). |
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

## Prepared EROFS root composition (#3024)

A composition request names already-prepared local EROFS files, never a URL,
Git source or raw mount command. The Agent verifies/stages those files from its
authorized EROFS cache (#3023); `nession-sandbox` re-verifies the exact bytes
before mounting anything.

- **Input.** `base` (read-only at `/`), optional `workspace.image`
  (read-only Project source) plus `workspace.write` (Agent-owned bounded
  writable directory), and zero or more `toolchains` whose targets are exactly
  `/opt/<lowercase name>`. Every image carries its `sha256:<64 hex>` digest and
  an absolute source path. Sources must be regular files, not symlinks, and
  must canonicalize beneath the Agent-authorized EROFS image root. Compile
  rejects malformed digests, unnormalized/relative paths, duplicate toolchain
  targets, non-`/opt` targets, and combining `composition` with
  `filesystem.access` (one owner for the root).
- **Mount mechanics.** The Linux backend mounts each image read-only with the
  unprivileged `erofsfuse` helper (a usable `/dev/fuse` is required). The probe,
  helper invocation, mountpoint readiness check and unmount live in the
  reusable `nession_erofs::mount` primitive (#3303), which returns an owned
  `ErofsMount` handle. `nession-sandbox` keeps source-root authorization, byte
  verification (through `nession_erofs::digest`), mount ordering, the overlay
  composition and the per-execution cleanup record; the primitive never sees
  an image role or a mount plan. A Project
  source image is merged with the bounded write directory through
  `fuse-overlayfs` (`lowerdir=<Project image>,upperdir=<write>/upper,workdir=<write>/work`);
  a workspace without an image is a direct writable bind. Bubblewrap starts
  from an empty tmpfs root, binds the Base Runtime over `/`, installs
  `/workspace`, then the toolchains, and only then mounts `/dev`, `/proc`,
  `/tmp`, `/home` and `/run/nession`.
- **Base Runtime contract.** Because the composed root is read-only, the image
  must already contain the mountpoint directories the backend installs:
  `/bin/sh` (or `/usr/bin/sh`), `/workspace`, every declared `/opt/<name>`,
  `/dev`, `/proc`, `/home`, `/tmp` and `/run/nession`. The Base Runtime also
  carries the glibc loader/libs the bridge and the shell need. Missing paths
  are a prepare error; the backend never extracts or copies a fallback root.
- **No privilege escalation.** The default Agent Pod is not made privileged:
  both helpers are FUSE-based and unprivileged. A host without `erofsfuse`,
  `/dev/fuse`, `fuse-overlayfs` when a Project image is present, or the
  authorized image root reports `UnsupportedPolicy`; there is no Native
  fallback and no kernel-loop mount substitution.
- **Lifecycle.** Every mountpoint lives under the execution directory
  (`mounts/...`), is recorded in the durable execution record, and is unmounted
  (reverse order: toolchains, overlay, Project image, Base Runtime) before the
  directory/record are removed. Reconciliation unmounts only recorded paths
  beneath that execution's own directory. A failed unmount keeps the record for
  retry rather than leaking the mount. Read-only images remain available to
  other Sessions because each execution has its own mountpoints over shared
  image bytes.
- **macOS.** EROFS composition is rejected with an explicit
  `UnsupportedPolicy("filesystem.composition … unsupported on macOS")`; no
  equivalence is claimed.

## Managed Workspace resources (#3407)

The Agent Workspace Manager owns named, durable, reusable managed Workspace
directories, their stable `ws_<uuid>` identities, inventory and deletion. A
Project Existing Location remains a Project-owned reference and is never
stored or deleted by that manager. See
[Agent-owned managed Workspaces](agent-workspaces.md).

The current managed-session and existing-Session paths still allocate a
per-execution writable directory
(`<sandbox state>/managed/<uuid>/workspace` or
`<sandbox state>/sandbox-workspaces/workspace-<uuid>`). A Filesystem
declaration that selects a managed Workspace now binds that Agent-owned
directory at `/workspace` and holds its RW lease until execution cleanup; the
directory is not deleted. A managed Workspace with a Project EROFS lower
(Overlay upper/work) and Project Location resolution are not implemented yet.

## Managed EROFS Session creation (#3062)

The Managed path turns a Project declaration plus a pinned artifact set into a
Session whose initial Pane runs in a prepared composition. Ownership is split
the same way as the rest of the stack:

- **Server.** `server.session.create` with a `managed` request (Base Runtime
  digest + optional `{digest, target}` toolchains) requires a Project whose
  `image_digest` pins the Project Source image. The Server normalizes and
  resolves every digest through the Image Manager, requires each artifact to be
  `ready`, mints one scoped grant per artifact (`grant_managed_access`, a
  Server-internal path that keeps the client-facing `server.image.access`
  Project-reference rule intact) and records the durable
  `session_managed_context` row (`preparing` → `ready`/`failed`). An
  `attempt_id` fences concurrent attempts for one Session name: a losing
  attempt cannot overwrite the winner's disposition.
- **Agent.** `agent.session.create` with the managed grants opens the durable
  identity-namespaced EROFS cache, downloads/verifies each image through the
  same `server.image.access` bearer path, creates one Agent-owned bounded
  workspace (`<sandbox state>/managed/<uuid>/workspace`) and builds a
  `filesystem.composition` policy: Base Runtime at `/`, Project Source at
  `/workspace` with the writable directory bound over it, toolchains at
  `/opt/<name>`. The sandbox cwd is `/workspace`; tmux starts in the
  Agent-owned host workspace. The policy is compiled before `new-session` and
  a host that cannot install it refuses the create — there is no Native
  fallback.
- **Statuses.** The Server persists `preparing` before dispatch and
  `ready`/`failed` after the Agent answers; a disconnect or timeout marks the
  attempt failed. Retrying a failed or timed-out attempt starts a new attempt
  (the cache is already warm) and a late reply from the previous attempt cannot
  rewrite the new attempt's row; a same-named create against an already
  `ready` Session is refused before dispatch so it cannot overwrite the
  winner. Killing a Session deletes its managed context; other Sessions'
  contexts, workspaces and shared image bytes are untouched.
- **Visibility.** The managed section is a Rust contract only (`ts(skip)` on
  the generated fields); the Web projection does not expose native image
  digests or paths. Web/app product surface remains #3025's scope.

### Existing-Session image composition (#3181)

An already-running Session can Enter a Sandbox Pane whose root is composed from
Server-owned images. The client never sends a native source path; it sends
`sandbox_image_selection` values (`role`, immutable `digest`, optional
`target`, `mode`) on preflight and Enter. The rules split by owner:

- **Policy shape.** `nession-sandbox`/`nession-protocol` validate the canonical
  composition: at most one `base` (read-only at `/`), at most one `workspace`
  (overlay at `/workspace`), any number of `toolchain` entries (read-only at
  `/opt/<name>`). A nonempty composition requires exactly one base, base and
  toolchain must be read-only, workspace must be overlay, and toolchain targets
  must be one lowercase-level `/opt/<name>`. A composition and
  `filesystem.access` remain mutually exclusive.
- **Server authorization.** The Server validates the selection shape, requires
  every digest to be Ready in the Image Manager, and mints one
  `grant_sandbox_access(session_id, digest)` grant per image on the Enter
  reply. The grant is Session-scoped and digest-bound; a client cannot turn a
  Project reference or a guessed digest into bytes. The Server forwards image
  metadata (digest/role/target/mode) on preflight — no token is minted before
  the mutation.
- **Agent preparation.** On Enter the Agent opens its identity-namespaced EROFS
  cache, fetches each grant through the same `server.image.access` bearer path,
  verifies the digest, and prepares one Agent-owned workspace directory under
  `<sandbox state>/sandbox-workspaces/workspace-<uuid>`. It then builds the
  canonical `filesystem.composition` and calls `prepare`. Only paths inside the
  authorized image root and that owned workspace reach the sandbox. A failure
  before the sandbox owns the workspace removes it; after a successful
  prepare, sandbox cleanup owns it through the composition record.
- **Preflight without fetch.** A preflight that includes images validates the
  selection and composes placeholder local paths, so host-capability checks run
  without downloading or reserving image bytes. Enter still re-probes.
- **Cache observation.** `server.session.sandbox.context` accepts optional
  `cache_digests` and answers `cache_statuses` with
  `verified | preparing | absent | failed | unavailable`. This is an Agent-local
  observation and is deliberately separate from the Server's image Ready state:
  a Server-Ready image that the Agent has not fetched is not mount-ready, and a
  failed or partial cache is never shown as verified.

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

### Native cgroup v2 resource passthrough (#3141)

The policy map is the kernel's own interface, not a Nession quota schema. There
are no CPU-core, byte or device conversions and no per-file value parsers:
`cpu.max` carries `quota period`, `io.max` carries its device/limit text, and
`memory.high` carries bytes or `max`, exactly as the kernel documents them.

Discovery and editing share one naming owner
(`nession-sandbox/src/cgroup_file.rs`):

- a key must be a single basename (no `/`, traversal, absolute path or
  surrounding whitespace);
- `cgroup.*` hierarchy/lifecycle interfaces (`cgroup.procs`, `cgroup.kill`,
  `cgroup.freeze`, `cgroup.subtree_control`, ...) are never policy writes —
  Nession owns enrollment, kill and delegation;
- read-only status suffixes (`.stat`, `.events`, `.current`, `.peak`,
  `.pressure`, `.numa_stat`, `.effective`) and command-style pseudo-files
  (`memory.reclaim`) are excluded. This is a shape rule, not a resource
  allowlist: a new declarative controller file needs no Nession change.

The capability probe creates a short-lived, empty child under the delegated
root, enables the delegated controllers, and enumerates the declarative files
that child actually exposes, with their current reads as UI hints. File
presence plus controller delegation is informational; it does not claim that a
particular value will install. The probe child is removed without enrolling a
process, so discovery never mutates a live execution or a foreign cgroup.

Enter creates the execution's owned child, writes every requested value
verbatim through a basename-only `O_NOFOLLOW` handle, and reads each file back
before the launcher enrolls any process. A kernel refusal (for example
`EINVAL` from an invalid `cpu.max`) names the file and OS error, fails the
create, removes the partial child, and leaves the Native Pane untouched — there
is no fallback. The observed readback, not the requested string, becomes the
execution's recorded effective Resource values; inside users therefore see what
the kernel reports.

Syscall is deliberately independent: seccomp is a loaded BPF program referenced
by the pinned `syscall.seccomp.profile` registry, not a cgroup pseudo-file.
`resource.cgroup_v2` passthrough does not relax that registry.

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

A host that serves `filesystem.composition` additionally needs unprivileged
FUSE: a working `/dev/fuse` (0666 or the Agent user's access), the
`erofsfuse`, `fuse-overlayfs` and `fusermount3` executables (resolved on
`PATH` unless configured), and an Agent-authorized EROFS image root from
`[erofs] storage_dir` (#3023). Both Agent images
(`Dockerfile.agent`/`Dockerfile.agent.prebuilt`) package those helpers:
`fuse3` provides `fusermount3`, `fuse-overlayfs` provides the overlay helper,
and `erofsfuse` is built from the pinned erofs-utils release in
`deploy/build-erofs-utils.sh`. The `/dev/fuse` device and the surrounding
namespace/cgroup policy remain deployment facts; the image itself is not
privileged (#3178, #3062). A host without them refuses the composition.

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
materializes them into `resource.cgroup_v2` / `syscall.seccomp`, applying the
generic native-basename rule (blank, malformed, lifecycle/status/command keys,
duplicates) and the pinned Syscall registry with field-level errors, and
**omits an empty group** rather than sending `{}`. It never parses a Resource
value's kernel format. `compile` and the launch barrier remain the only policy
authorities. The Agent's capability catalog
(`resource_fields`, `syscall_fields`, `probe_generation`) is measured from its
real delegated child cgroup and profile registry; it feeds UI suggestions, and
stale probes are revalidated on preflight/Enter.

### Per-implementation support discovery (#3161)

`SandboxCapabilityCatalog.catalog_version = 2` adds `implementations`, one
entry per **canonical policy path** (`filesystem.access`,
`filesystem.composition`, `network`, `process.linux_namespaces`,
`resource.cgroup_v2`, `syscall.seccomp`). Each entry has a typed
`available | unavailable | unknown` status, a stable `reason_code`
(`platform_unsupported`, `backend_missing`, `kernel_feature_missing`,
`controller_not_delegated`, `permission_denied`, `profile_unavailable`,
`implementation_not_built`, `not_probed`, `timeout`), a diagnostic reason, and
implementation-owned typed `options`/`fields`. Only schema-known paths can
appear; a frontend label never authorizes policy bytes, and a hypothetical
future `resource.macos_*` is not synthesized until its backend registers it.

The catalog is measured from the same `Capabilities` that `validate` consumes:
network modes, namespace flags, discovered child-cgroup controller files and
the pinned seccomp profile each carry their own status. `probe_generation`
hashes the measured implementation facts, so a capability change changes both
the context `generation` and the catalog generation. A backend-missing probe
reports every implementation unavailable (Linux-native paths on macOS keep
`platform_unsupported`); it never advertises eligibility, and it does not
fabricate a cgroup file list without a measurable child. An offline Agent is
`unknown`/`not_probed` rather than an empty kernel feature set.

Preflight and Enter both take the client's `context_generation` and
`probe_generation`; either mismatch is a `stale-generation` field error before
any host resource is created. `nession-sandbox::unsupported_requests` projects
every explicitly requested implementation/option the host cannot install into
canonical field paths (for example `resource.cgroup_v2.cpu.max`), with no
partial fallback; the single `validate` gate remains the backstop. The flat
`resource_fields`/`syscall_fields` arrays remain as a pre-v2 projection for
older clients; new clients read `implementations`.

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
- EROFS composition uses unprivileged FUSE helpers only. Kernel loop mounts are
  not used, and an NFS PVC holding image bytes is not a promise that NFS is
  suitable for the writable upper/work; the Agent must place the write tree on
  a supported local filesystem.
- The Node/Rust toolchain EROFS bundles are supplied by the image/build owner.
  The bounded packager that would let the staging Case build them inside its
  verifier budget is not implemented; SC-03 therefore stays Pending until that
  exact lane exists.

## Enforcement and proof

| Invariant | Owner |
|---|---|
| Policy shape and unknown-key refusal | `crates/nession-protocol/src/contracts/sandbox/v1.rs` + protocol Gates |
| Validation, capability probing, no fallback | `crates/nession-sandbox/src/policy.rs`, `capabilities.rs` |
| Launcher argv, masking, seccomp baseline | `crates/nession-sandbox/src/linux/bwrap.rs`, `linux/seccomp.rs` |
| EROFS composition shape and validation | `crates/nession-protocol/src/contracts/sandbox/v1.rs` + `crates/nession-sandbox/src/policy.rs` |
| Prepared image digest/mount/overlay and unmount | `crates/nession-sandbox/src/linux/erofs.rs` |
| Composition mount ordering and read-only root | `crates/nession-sandbox/src/linux/bwrap.rs` |
| Cgroup delegation, limits and cleanup | `crates/nession-sandbox/src/linux/cgroup.rs` |
| Launch barrier and proxy identity | `crates/nession-sandbox/src/linux/channel.rs`, `src/bridge.rs` |
| Context snapshot, generation and Enter idempotency | `crates/nession-agent/src/tmux/sandbox_context.rs`, `crates/nession-server/src/server/handler/server_session_sandbox_*_v1.rs` |
| Draft rows → canonical policy, per-implementation catalog | `crates/nession-sandbox/src/draft.rs`, `capabilities.rs` |
| Preflight/Enter generation binding and unsupported field paths | `crates/nession-sandbox/src/capabilities.rs` (`unsupported_requests`), `crates/nession-agent/src/tmux/sandbox_context.rs` |
| Owned-resource reconciliation (by Pane) | `crates/nession-sandbox/src/exec.rs`, `crates/nession-agent/src/sandbox_runtime.rs` |
| Real Linux behaviour | `crates/nession-sandbox/tests/linux_runtime.rs`, `e2e/acceptance/cases/2681/` and `e2e/acceptance/cases/3024/` |
| Existing-Session Enter and active-Pane context | `e2e/acceptance/cases/3124/` (real Server + Agent), `e2e/tests/browser/sandbox-workspace-capability.spec.ts` |
| macOS verified scope | `crates/nession-sandbox/src/macos/` (probe tests run on macOS) |

## References

- #2681 — normative Requirement and Acceptance Plan (create-time V1).
- [#3124](https://github.com/BestNathan/nession/issues/3124) — context
  capability, policy editor and existing-Session Enter.
- [#3161](https://github.com/BestNathan/nession/issues/3161) — per-policy
  implementation support discovery and Agent-gated configuration.
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

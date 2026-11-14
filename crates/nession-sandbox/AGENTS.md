# nession-sandbox Instructions

This scope owns execution isolation for one on-demand `SandboxExecution`
(#2681). It is **not** a container runtime, an image/rootfs manager, an
environment-binding owner, or a second tmux owner.

Read [docs/architecture/sandbox-policy-and-execution.md](../../docs/architecture/sandbox-policy-and-execution.md)
before changing the policy schema, the backends, the launch order or the
lifecycle. The Issue is the normative product decision; this file is the
path-local engineering invariant.

## Ownership

- **`nession-sandbox` owns isolation.** Policy compilation/validation,
  capability probing, the native backends, the trusted launcher argv, the
  in-sandbox bridge, the launch barrier, owned-resource cleanup and restart
  reconciliation live here.
- **`nession-tmux` stays generic.** It receives an explicit argv through
  `NewSession.command`; it never learns what a sandbox is.
- **The Agent's `SessionService`/`SessionManager` owns Session lifecycle.**
  It decides when a Session is created or killed, supplies the cgroup/Secret
  context, and calls prepare/verify/cleanup at the right transition.

Do not add a second policy validator, a second bwrap argv builder, or a second
"is the sandbox running" probe.

## Non-negotiable behaviours

1. **Compile/validate has no host side effects.** `policy::compile` only
   validates and normalizes. Host resources are created by `exec::prepare`.
2. **There is no fallback to Native.** An explicitly requested guarantee that
   the host cannot install returns `UnsupportedPolicy`/`BackendUnavailable`,
   and the caller refuses the create. Never strip a requested dimension and
   continue.
3. **No user string is interpreted by the launcher shell.** The launcher is a
   fixed `/bin/sh` program with positional arguments; the only variable it
   evaluates is `$$` for cgroup enrollment.
4. **The launch barrier is real.** The bridge runs inside the PID namespace,
   reports facts and waits for
   `GO`; user code starts only after the host verifies namespaces, cgroup,
   seccomp and its filesystem probes. Never move GO before verification.
5. **Proxy identity is kernel peer identity.** A proxy connection is accepted
   only when `SO_PEERCRED` names the execution's bridge PID. The socket path
   alone is not an identity.
6. **Cleanup removes owned resources only.** cgroup operations stay under the
   Nession cgroup root; filesystem removal stays under the Agent sandbox state
   directory and the Agent-owned short runtime root
   (`/tmp/nession-sandbox/<execution_id>`) used when the state directory is too
   deep for a `SUN_LEN`-bounded Unix socket. The runtime directory is removed
   only when its parent is the configured root and its name is exactly the
   execution id. Never kill or remove anything identified only by a
   caller-supplied path.
7. **A failed tmux listing is not "no Sessions".** Reconciliation and the
   reaper skip the pass; only a successful snapshot may release resources.

## Platform truth

- Linux native mechanisms mean exactly what Linux means by them:
  `process.linux_namespaces`, `resource.cgroup_v2`, `syscall.seccomp`.
- macOS reports only what its probe verified. V1 verifies network denial;
  `filesystem.access`, Linux namespaces, cgroup v2 and seccomp are rejected
  with `UnsupportedPolicy`. `setrlimit` is never a cgroup substitute.
- Backend baseline namespaces (user, pid, ipc, uts, mount) and the pinned
  seccomp profile are created for every execution. They are safety
  prerequisites, not additional user-requested constraints.

## Prepared EROFS composition (#3024)

- `filesystem.composition` is a **prepared local image input**, not an image
  builder/puller. The Sandbox re-verifies every digest and authorizes every
  source beneath the Agent EROFS image root; it never fetches, extracts or
  resolves a logical image.
- The compatibility root is an empty tmpfs + Base Runtime at `/`; `/workspace`
  is a read-only Project image merged with a bounded writable upper/work via
  `fuse-overlayfs` (or a direct bind when no Project image exists). Toolchains
  are read-only and only `/opt/<name>`. Do not add arbitrary overlapping-root
  ordering or an image with a writable upper inside it.
- Mount helpers are unprivileged FUSE only (`erofsfuse`, `fuse-overlayfs`,
  `fusermount3`). Never substitute a kernel loop mount, extraction, container
  layer, tmpfs or Native fallback when a helper/capability is absent; report
  `UnsupportedPolicy`.
- The Base Runtime image owns its mountpoint directories (`/bin/sh`,
  `/workspace`, each `/opt/<name>`, `/dev`, `/proc`, `/home`, `/tmp`,
  `/run/nession`). The read-only composed root cannot grow them at launch.
- Read-only image mounts are **shared and lease-managed** (#3449). The
  Agent-owned `nession_erofs::mount_manager::MountManager` owns one physical
  FUSE mount per verified digest for an Agent identity/mount namespace. The
  Sandbox calls `acquire` and records a consumer lease; a lease carries no
  unmount authority. Only the manager reclaims after the last identified
  consumer and a strict, bounded unmount. The manager root is not the
  execution directory.
- Execution-owned resources (the writable Overlay mount and temporary files)
  remain under the execution directory and are recorded. Cleanup unmounts or
  releases only this execution's own resources; reconciliation never trusts
  an arbitrary record path and never unmounts a manager-owned physical mount.

## Per-implementation discovery (#3161)

`capabilities::catalog` reports one typed entry per canonical policy path
(`filesystem.access`, `filesystem.composition`, `network`,
`process.linux_namespaces`, `resource.cgroup_v2`, `syscall.seccomp`). Status
and reason codes come from the same measured `Capabilities` `validate` uses;
`probe_generation` hashes those facts. A missing backend marks every
implementation unavailable; never advertise eligibility from a platform guess
or an empty list. `capabilities::unsupported_requests` is the field-path
projection for preflight/Enter; `validate` remains the single fail-closed gate.

`resource.cgroup_v2` fields are discovered, not allowlisted (#3141): the probe
enumerates the declarative controller files its delegated child exposes, and
`cgroup_file.rs` is the one owner of the basename/lifecycle/status/command
rules. A policy key the child did not expose fails closed; the kernel remains
the authority for each raw value at write time.

## cgroup delegation

The execution root needs a cgroup with delegated controllers and no processes
of its own. Probe, never assume: a host that cannot delegate reports
`UnsupportedPolicy(resource.cgroup_v2)`. Cleanup uses the record's
kernel-relative path and only removes a direct child of the Nession root.

## Verification

```bash
cargo test -p nession-sandbox
./gates/run rust-clippy rust-format
./gates/run protocol-integrity protocol-codegen-drift
```

The real Linux path is `tests/linux_runtime.rs`; it requires Bubblewrap and,
for the cgroup assertions, a delegated writable cgroup v2 subtree named by
`SANDBOX_CGROUP_ROOT` (the capability probe binary reads the same override).
Acceptance Cases live under `e2e/acceptance/cases/2681/`.

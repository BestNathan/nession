---
title: "Nession Sandbox policy and execution isolation architecture"
description: "Approved policy boundaries, native OS mechanisms, prepared EROFS root composition, network domain controls, backend ownership, and persistent tmux execution constraints"
topic: engineering
categories: ["agent","architecture","sandbox","security"]
status: candidate
created_at: 2026-11-03T08:52:21.743Z
updated_at: 2026-11-10T04:59:00Z
sources: ["https://github.com/BestNathan/nession/issues/2681","https://github.com/BestNathan/nession/issues/3124","https://github.com/BestNathan/nession/pull/3066","https://github.com/BestNathan/nession/blob/59e0bbbe380e678a88e331c8b0fe131cfbe2fd48/docs/architecture/sandbox-policy-and-execution.md","https://github.com/BestNathan/nession/blob/1987709a23240312758663c4a522d53b8abd5033/docs/architecture/sandbox-policy-and-execution.md","https://github.com/BestNathan/nession/blob/0173f403c6d791e9d8152e196dad288fce113e66/docs/architecture/sandbox-policy-and-execution.md","https://github.com/BestNathan/nession/blob/943e9e7f43265cbd7199c9979e6a8bf7d8f55f06/environments/staging/nession/patch-agent-sandbox.yaml","https://github.com/BestNathan/nession/blob/dab5685f536722069e3c6c62ff112d8abae3e1a5/docs/architecture/session-tmux-sdk-ownership.md","https://github.com/BestNathan/nession/blob/dab5685f536722069e3c6c62ff112d8abae3e1a5/docs/architecture/agent-process-discovery.md","https://github.com/BestNathan/nession/blob/cbd20ff8ea2e5d45850aef5c17287083eee9922a/docs/architecture/sandbox-policy-and-execution.md", "https://github.com/BestNathan/nession/issues/3024", "https://github.com/BestNathan/nession/pull/3135", "https://github.com/BestNathan/nession/blob/27c200961bb3a95aed9cd7368062a099a633e2d4/docs/architecture/sandbox-policy-and-execution.md", "https://github.com/BestNathan/nession/blob/27c200961bb3a95aed9cd7368062a099a633e2d4/crates/nession-sandbox/src/linux/erofs.rs", "https://github.com/BestNathan/nession/blob/27c200961bb3a95aed9cd7368062a099a633e2d4/crates/nession-sandbox/src/policy.rs", "https://github.com/BestNathan/nession/blob/27c200961bb3a95aed9cd7368062a099a633e2d4/crates/nession-sandbox/src/linux/bwrap.rs", "https://github.com/BestNathan/nession/blob/27c200961bb3a95aed9cd7368062a099a633e2d4/crates/nession-sandbox/tests/linux_runtime.rs"]
---

# Nession Sandbox policy and execution isolation architecture

## Decision and present status

**Owner decision, approved 2026-11-03:** Nession Sandbox is one **optional SandboxPolicy** with replaceable, capability-probed backends. Five policy groups are filesystem, network, process, resource, syscall. **Resource is a group inside SandboxPolicy**, not another product service, API, or independent runtime. Session Environment Binding is separate and remains owned by the Session. A Session is Native unless it explicitly requests a policy; an explicit policy the host cannot honour fails closed rather than falling back.

**Implementation status (2026-11-09): the create-time V1 is delivered on [PR #3066](https://github.com/BestNathan/nession/pull/3066) at `59e0bbbe`; merged-staging Acceptance for the Linux criteria passed at `1987709a` (Acceptance / Cases run `42575857638`: SC-02, SC-03, SC-04, SC-05 and SC-07).** The approved design below is unchanged. The first implementation slice is the `nession-sandbox` crate plus Agent/Server/CLI integration, documented as current architecture in [Sandbox policy and execution isolation](https://github.com/BestNathan/nession/blob/59e0bbbe380e678a88e331c8b0fe131cfbe2fd48/docs/architecture/sandbox-policy-and-execution.md). Both Agent images now ship Bubblewrap and project `[sandbox]` from `AGENT_SANDBOX_*`; the merged-staging Case runner provisions Bubblewrap, unprivileged user namespaces and a delegated cgroup v2 subtree. The staging Agent Deployment also mounts the host cgroup tree writable and runs privileged (GitOps `943e9e7f`); a deployed Session created on 2026-11-09 reported verified `network.deny`, PID/IPC/User namespaces, `/nession-staging/<execution>` cgroup membership and seccomp, and released its cgroup and record on kill. The full merged-staging run `42615261597` at `0173f403` then passed all Linux criteria and **SC-06 on the GitHub-hosted `macos-15-intel` runner** (real Seatbelt network deny and Linux-native-key refusal). **A trusted `when: deployed` Case lane (remote profile #1616) remains pending**; the deployed Session proof above is manual. Article status stays **candidate** until that authenticated deployed receipt exists. **The context capability and existing-Session Enter were delivered by [#3124](https://github.com/BestNathan/nession/issues/3124) on `cbd20ff8e` (PR #3127), with PR-stage browser Cases SC-05/SC-06, Agent SC-02/SC-07, and merged-staging runtime Cases SC-01/SC-03/SC-04 binding the current code.** **Prepared EROFS root composition was delivered by [#3024](https://github.com/BestNathan/nession/issues/3024) (PR #3135, merged at `27c200961`): PR-head Cases SC-01/SC-05 passed in run `42734771485` at `937542ee9`; merged-staging SC-02/SC-04 passed in Acceptance / Cases run `42735635683` at `27c200961`; SC-03 was observed by a one-time controlled CI Task (run `42746628119`, receipt in `task-results`) because no committed Node/Rust bundle packager exists. The Issue closed with every criterion Pass; the Task receipt and the composition's limits are recorded below.** The design below is not itself evidence of a Pass; the cited Issue, runs and deployment own the exact receipts.

### Core execution boundary

    SessionService / SessionRegistry (Session lifecycle and optional policy reference)
      -> nession-sandbox (validate, probe, launch, own execution resources)
           -> Linux backend: Bubblewrap + delegated cgroup v2 + seccomp as requested
           -> macOS backend: verified native Seatbelt capabilities only
      -> nession-tmux (generic tmux process/typed command owner)
           -> one private shared tmux server -> Pane -> sandbox launcher -> shell/children

The shared tmux server does not enter a sandbox or its resource domain. No additional tmux server per Session is required. Browser attach/detach is not sandbox ownership; a running Pane and its execution may outlive WebSocket disconnection and Agent connection replacement. Nession's existing terminal transport, control lease, resize, replay and recovery semantics remain the controlling owners.

### What the V1 implementation actually does

Source-aligned facts from the first implementation (design claims above remain the contract):

- `nession-sandbox` compiles/validates the versioned schema without host side effects, probes the actual host, and fails closed when a requested guarantee cannot be installed. It is the sole isolation owner; `nession-tmux` receives only an explicit argv, and the Agent's SessionService owns Session lifecycle.
- Linux uses Bubblewrap with a trusted `/bin/sh` launcher that enrolls the Pane PID in an execution cgroup and opens the pinned seccomp profile. Mount, user, PID, IPC and UTS namespaces and the seccomp profile are baseline safety prerequisites; the policy's native groups are a subset of what is verified.
- The in-sandbox bridge reports `/proc/self/ns/*`, cgroup, `Seccomp`/`NoNewPrivs` and filesystem probes, then waits. The Agent authenticates the channel peer, compares the facts with its own observation and only then releases the shell. Bubblewrap may hold in-namespace PID 1 (measured with bubblewrap 0.8); the bridge reaps what is reparented to it.
- Restricted mode uses a host-side SOCKS5/HTTP-CONNECT proxy whose peer identity is the kernel's `SO_PEERCRED` bridge PID. Deny wins, a name allow rule authorizes its validated public resolutions, and direct/private/host-local/metadata egress is refused.
- cgroup cleanup uses the record's kernel-relative path and only a direct child of the Nession root. Delegation requires a cgroup with controllers and **no processes of its own**; a plain container whose root cgroup hosts PID 1 fails closed. Restart reconciliation compares records against a successfully listed tmux **Pane** set (a removed Window is not a live execution merely because its Session name lives).
- macOS verified scope is exactly network denial under Seatbelt. Path allow-lists could not be expressed with the measured Seatbelt compiler, so `filesystem.access` is rejected rather than approximated; Linux namespaces, cgroup v2 and seccomp are rejected as Linux-native, and `setrlimit` is not treated as cgroup v2.
- Known V1 limit discovered in implementation: restricted proxying does not survive the Agent process itself (the Pane and its cgroup do); a restarted Agent services new executions only.

### Prepared EROFS composition (#3024)

Sandbox consumes prepared EROFS bytes; it never builds, pulls or resolves an image. `filesystem.composition` is a versioned policy input with a Base Runtime image (read-only at `/`), an optional Project source image plus an Agent-owned writable directory at `/workspace`, and read-only toolchains restricted to `/opt/<name>`. Every image carries `sha256:<64 hex>` and an absolute local source. Compile rejects malformed digests, unnormalized/relative/path-escaping sources, duplicate or non-`/opt` targets, a missing writable workspace, and combining composition with `filesystem.access` (one owner for the root). The Web draft projection omits composition: it is an Agent/Server-prepared input, not a client-editable policy field.

The Linux backend re-hashes each source and requires it to be a regular, non-symlink file beneath the Agent-authorized EROFS image root delivered by [Global EROFS Image Manager](global-erofs-image-manager.md) (#3023), mounts it read-only with unprivileged `erofsfuse`, and merges a Project image with `<write>/upper` + `<write>/work` through unprivileged `fuse-overlayfs`; a workspace without a Project image is a direct writable bind. Bubblewrap starts from an empty tmpfs root, binds the Base Runtime over `/`, installs `/workspace`, then the toolchains, and only afterwards mounts `/dev`, `/proc`, `/tmp`, `/home` and `/run/nession`. Because the composed root is read-only, the Base Runtime image must already contain the mountpoint directories (`/bin/sh`, `/workspace`, each `/opt/<name>`, `/dev`, `/proc`, `/home`, `/tmp`, `/run/nession`); a missing path is a prepare error. No kernel loop mount, extraction, container-layer fallback or Native fallback exists, and the Agent Pod is not made privileged.

Every mountpoint lives under the execution directory and is recorded. Cleanup unmounts in reverse order (toolchains, overlay, Project image, Base) before removing the execution directory/record; reconciliation unmounts only recorded paths beneath that execution, and a failed unmount keeps the record for retry. Read-only image bytes remain shared across Sessions while each execution owns its own mountpoints.

Evidence: SC-01/SC-05 passed at PR head `937542ee9` in Case Smoke run `42734771485`; merged-staging SC-02/SC-04 passed in Acceptance / Cases run `42735635683` at `27c200961` (real Linux kernel `7.0.0-1017-azure`: shell, Git, `fuse.erofsfuse` + `fuse.fuse-overlayfs` mountinfo, host the host shadow password database absent, four owned mounts released; two executions shared images, survived client detach and released only their own mounts). SC-03 was observed by a one-time controlled CI Task `42746628119` (source `7f4498de2`): a Base Runtime EROFS (`sha256=289dbf71…`, 1,727,324,160 bytes), Node EROFS (`sha256=41096d86…`, 133,013,504 bytes, Node v24.22.2) and Rust EROFS (`sha256=05cfe32b…`, 612,855,808 bytes, rustc 1.96.0) produced `NODE=v24.22.2`, a compiled `rust-sc03-ok`, `GIT=git version 2.56.0` and three FUSE mounts. That receipt is an untrusted Task observation accepted by the owner because the staging Case lane has no bounded Node/Rust bundle packager; it is not a committed Case.

Limits: the Agent base image still does not package `erofsfuse`/`fuse-overlayfs` or expose `/dev/fuse`; the managed Session lane (#3062) owns supplying them without a privileged Pod. NFS holding EROFS bytes is not promised as an OverlayFS upper/work filesystem. There is no arbitrary overlapping-root ordering, writable image upper or OCI/image pulling. The SC-03 Task proof is one-time evidence; a committed bundle-packaging Case remains follow-up work.

### Context capability and existing-Session Enter (#3124)

Sandbox is a **Session-context capability over the selected active Pane**, not a host monitor. `server.session.sandbox.context` answers exactly `inside | outside | unknown`: the Agent resolves the active Pane on its private tmux server (`window_active` + `pane_active`), matches a tracked execution by exact `pane_id` (a pre-#3124 record falls back to its recorded root PID), and requires the Session's durable `instance_id` to match. A measured backend is **Enter eligibility**, never containment; a same-named recreation never inherits an older execution.

Outside, the Workspace composes a Web-safe `SandboxPolicyDraft`: `filesystem.access.read/write`, `network.mode` (+egress), `process.linux_namespaces`, and **empty-first** Resource/Syscall `{key, value}` rows. `nession-sandbox` materializes those rows into the canonical `SandboxPolicy` with field-level errors, omits empty groups, and remains the only validator; the canonical policy and `deny_unknown_fields` are unchanged. The Agent capability catalog is measured (per-field child-cgroup installability **∩** the V1 control-file allowlist, and probed registered seccomp profiles), so a missing CPU delegation removes `cpu.max` from suggestions and a manually typed key still fails preflight.

Preflight is a no-side-effect compile + host-capability validation. `server.session.sandbox.enter` is the single explicit mutation: it re-reads the context, requires the preflight's generation, re-probes through `prepare`, creates a **detached `new-window` in the same logical Session**, verifies the launch barrier, and only then moves focus. A failure removes exactly the Window the attempt created; the original Native Pane is never written to and stays focused. A repeated client `enter_id` replays the completed outcome instead of launching again. Return to Native and Focus are focus switches; the Sandbox execution keeps running.

Execution records now carry `pane_id`/`window_id`, the normalized effective policy, the verified mechanisms/warnings and the preserved Native Pane, so the inside view survives an Agent restart. Reconciliation and the reaper are Pane-keyed: a removed Window is cleaned while its Session name lives. The inside projection shows the observed effective policy (never the last draft), the verified mechanisms and the Pane-only coverage statement.

## Policy schema philosophy

Nession Sandbox is a **schema of supported capabilities**, not an attempt to define portable equivalents for every kernel primitive. A common field is appropriate only if it has the same provable contract across operating systems, such as network target authorization. A native field should name the underlying primitive and use its native semantics, for example:

- resource.cgroup_v2: Linux cgroup v2 controller files and supported native values.
- syscall.seccomp: Linux seccomp-BPF profile reference (note: a profile name is a Nession-owned catalog reference, not a kernel control-file name).
- process.linux_namespaces: Linux PID, IPC, User, UTS and Cgroup Namespace flags.
- network.mode and network.egress: target-oriented allow/deny/restricted policy with OS-specific trusted enforcement.
- filesystem.access: intended readable/writable/hidden host paths, with mounts chosen by backend.

**Explicit requested guarantees are mandatory.** Backend probe/validation rejects unsupported constraints; do not translate cgroup limits to macOS setrlimit as if they were equivalent, and do not silently strip requested seccomp or Linux Namespace constraints. Kernel API support, executable availability and cgroup controller delegation are separately probed facts. An optional absent group introduces no additional user-requested policy for that group, but cannot disable the backend's necessary safety prerequisites.

Illustrative Linux-targeted configuration (values preserve native cgroup v2 units and formats):

    sandbox:
      enabled: true
      filesystem:
        access:
          read: [/usr, /workspace]
          write: [/workspace, /tmp]
      network:
        mode: restricted
        egress:
          allow: ["api.anthropic.com:443", "github.com:443", "*.npmjs.org:443"]
          deny: ["*.internal.example"]
          private_network: deny
        ingress: deny
      process:
        linux_namespaces:
          pid: true
          ipc: true
          user: true
          uts: false
          cgroup: false
      resource:
        cgroup_v2:
          memory.max: "2147483648"
          cpu.max: "200000 100000"
          pids.max: "256"
          memory.oom.group: "0"
      syscall:
        seccomp:
          profile: nession-interactive-v1
      enforcement: required

This is the **proposal's example**, not yet the compiled production Schema. Explicit native keys must be allowlisted and validated; arbitrary writes to cgroupfs or arbitrary BPF blobs are not accepted.

## Filesystem access

Filesystem policy constrains the visible path tree and read/write access. On Linux, Bubblewrap constructs a private mount view by binding only allowed host paths; a writable bind mount writes the original host files. A read-only filesystem bind does NOT make path-visible Unix sockets safe: socket connection permissions and filesystem visibility are separate concerns. The Backend also validates symlinks, mount propagation, privileged FDs, tmux/D-Bus/Docker sockets and the chosen initial working directory.

An independent pre-existing RootFS or OverlayFS view may be introduced later. V1 does not download OCI images, manage EROFS/OCI layers, provision a VM, or persist a general container filesystem.

## Network access: explicitly target-oriented

The network contract supports:
- **allow** — inherit host IP network behavior without additional network restrictions.
- **deny** — prohibit outside IP network, including host localhost and LAN; a new Linux namespace may still allow sandbox-internal loopback.
- **restricted** — default-deny destination policy using approved/rejected Domain/IP/Port. Exact domain, explicit wildcard subdomains (wildcard does not match the base domain), optional port, and deny precedence are normative. Unlisted destinations are denied.

A trusted **host-side proxy**, not an in-sandbox or client-identity-trusting proxy, authenticates each SandboxExecution's channel and performs target authorization. Linux may use Bubblewrap Network Namespace plus a restricted proxy channel; macOS may use Seatbelt-based OS access restrictions if actually tested. Environment variables such as HTTP_PROXY are convenience hints only; they do not enforce sandbox networking.

Security requirements:
1. No direct egress bypass (TCP, UDP, QUIC); no host localhost/private network/metadata by default in restricted mode.
2. Resolve hostname, validate every effective IPv4/IPv6 destination, connect to **the validated address**, and reauthorize each new connection to avoid rebinding, address-family and time-of-check/time-of-use bypass.
3. Authenticate proxy policy scope using a host-controlled channel or identity; never trust a user-supplied Session ID alone.
4. Review inherited FDs and path-based Unix socket exposures; Linux Network Namespace alone does not isolate every socket or trusted external service.
5. Ingress/port publishing is denied by default and requires a later explicit authenticated forwarding design.

Non-goals: network VPN, bridge/routing orchestration, DLP, HTTPS MITM, request-content/method/path authorization or unrestricted SOCKS UDP. A host/port allowlist does not prevent data exfiltration to an already allowed destination. Out-of-sandbox MCP/services are outside this policy's execution boundary.

## Process: direct Linux Namespace mechanisms

The V1 process group is process.linux_namespaces: pid, ipc, user, uts, cgroup.
- **pid:** isolated PID mapping and process visibility; proper in-namespace /proc and PID1/reaper setup. An ancestor host PID namespace can still observe children with appropriate rights.
- **ipc:** independent System V IPC/POSIX message queues; NOT isolation of every Unix-domain socket, inherited FD, or file-backed shared mapping.
- **user:** scoped UID/GID mapping and Linux capability interpretation; backend supplies safe fixed mappings, not arbitrary user-controlled host mappings. Root in a User Namespace does not become host root.
- **uts:** independent hostname/domain name (not a new machine or network stack).
- **cgroup:** cgroup path visibility only; **not cgroup v2 quota**.

Mount Namespace belongs to filesystem policy; Network Namespace belongs to network policy. Backend may create additional namespaces internally where necessary for safe implementation, but these do not imply extra user-requested guarantees.

macOS does not have equivalent native PID/User/IPC Namespace semantics. A macOS backend must reject process.linux_namespaces when requested and may expose Seatbelt-specific process-operation constraints only after a separate verified contract. Seatbelt restrictions on signal/process operations are not a substitute for isolated PID view.

## Resource: exact cgroup v2 contract

The V1 resource.cgroup_v2 allowlist initially covers:
- **memory.max:** byte count or kernel-accepted max; memory accounted by cgroup v2 (not sum of process RSS). If pressure cannot be reclaimed, memcg OOM may occur.
- **cpu.max:** quota and period in cgroup v2's native two-token format, e.g. 200000 100000; not CPU affinity.
- **pids.max:** limit on kernel tasks (including threads), not only distinct process IDs.
- **memory.oom.group:** conditional group-OOM behavior, when supported and deliberately configured.

Nession owns an **execution-scoped cgroup**, not a separate shared tmux server cgroup. Every included descendant must run inside the configured domain before untrusted code executes. The chosen ResourcePolicy does **not** automatically limit Native Pane processes or aggregate the entire Nession Session across multiple independently created SandboxExecutions. Parent Kubernetes Pod or systemd cgroup limits may trigger earlier and thus still affect the Agent.

The Backend must actually verify writable delegated controllers and the committed effective values, not just detect a mounted cgroup filesystem. Report available cgroup events and resource counters with clear unknown/denied states; read-only Session process discovery (#2514) is not the controller or authority. macOS lacks a direct equivalent and must reject resource.cgroup_v2; setrlimit(RLIMIT_AS/RLIMIT_CPU) is not an equivalent CPU-quota/memcg contract.

Reference: [Linux cgroup v2 kernel specification](https://docs.kernel.org/admin-guide/cgroup-v2.html).

## Syscall: explicit Linux seccomp

The V1 syscall.seccomp group references a **versioned, tested builtin seccomp-BPF profile**, not an arbitrary user-provided syscall blacklist/allowlist. Filter validation must account for architecture and compatible syscall behavior. Filters constrain syscall numbers and limited direct argument values; they cannot dereference pointers to implement pathname authorization and cannot replace filesystem policy. Inherited filters are generally irreversible or only further restrictable, not dynamically loosened.

Backend-level safety requirements remain in force even when syscall policy is absent: no_new_privs where appropriate, reduced capabilities, protected controlling-TTY behavior (including TIOCSTI), and no inherited privileged FD or tmux control socket. These conditions must be verified against interactive Bash/Zsh, vim/top, Claude Code/Codex, language runtimes, fork/threading, Ctrl+C/Ctrl+Z/fg/bg and resize. Do not globally ban clone/clone3/ioctl without compatibility and threat-model evidence.

macOS does not provide Linux seccomp-BPF equivalence; Seatbelt's separate operation restrictions are not a substitute for syscall.seccomp.

Reference: [Linux seccomp-BPF kernel documentation](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html).

## Backend, startup safety and ownership

The backend provides capability probe, deterministic policy validation, a trusted launcher, effective-state reporting, a process/namespace/cgroup/proxy execution handle, and idempotent cleanup/reconciliation of **Nession-owned** host resources. An implementation can combine Bubblewrap + cgroup v2 + seccomp, use a different proven open-source executor, or later replace parts with native Rust while keeping Policy guarantees and tests.

V1 supports **on-demand sandbox execution** from a Native Session. It does NOT promise enforced whole-Session isolation. For example, a trusted tmux Server receiving run-shell or a command-overriding new-window/split-window can perform host-side work outside a Pane's sandbox. The shared tmux socket and trusted control plane must be excluded from untrusted sandbox access, and any claimed protection must cover direct and indirect TTY/socket escape paths. A shell exiting an on-demand sandbox may return to its existing Native Session.

The launch contract:
1. Compile/validate without creating host resources; fail on unsupported explicit native capabilities.
2. Prepare owned resource domain and trusted proxy channels; establish actual constraints before releasing untrusted code.
3. Start the sandbox child behind a verified launch barrier; no code runs in an unprotected interval.
4. Report exact effective policy and stable execution identity, without leaking secrets or raw privileged arguments.
5. On failure or normal exit, terminate/reap owned processes and release owned external resources; errors are observable and cleanup idempotent. Ordinary user writes to shared workspaces are **not** rollback-able.
6. Browser detach does not kill the running execution; on Agent restart reconcile known owned resources against current tmux state and avoid deleting another execution's domains.

Bubblewrap Namespace and private mounts normally end when their final references exit; cgroup directories, temporary host files, proxy handles and external services may require explicit cleanup. Generic transaction/rollback engines and separate long-lived SandboxInstance records are not needed for V1. Compile/validate cannot claim an installed policy merely because a requested option was accepted by a CLI.

## Cross-platform truth table

| Contract | Linux backend | macOS backend |
|---|---|---|
| filesystem.access | Bubblewrap mount view | **Rejected in V1**: the measured Seatbelt compiler cannot express a verified path allow-list |
| network allow/deny/restricted | Network Namespace plus trusted host proxy | Deny verified; **restricted rejected in V1** |
| process.linux_namespaces | PID/IPC/User/UTS/Cgroup Namespace (per request) | Unsupported |
| resource.cgroup_v2 | Kernel cgroup v2 with real delegation | Unsupported |
| syscall.seccomp | seccomp-BPF verified builtin profile | Unsupported |

macOS sandbox-exec is deprecated and should be treated as a version-probed, risk-documented dependency rather than an assured permanent public API. Process/file/network restrictions are mechanism-specific, not automatically equivalent to a Linux PID, Network or User Namespace.

## Evidence, validation and known limitations

- **Normative design owner:** [Requirement #2681](https://github.com/BestNathan/nession/issues/2681). Implementation: [PR #3066](https://github.com/BestNathan/nession/pull/3066) at `59e0bbbe`; current architecture: [Sandbox policy and execution isolation](https://github.com/BestNathan/nession/blob/59e0bbbe380e678a88e331c8b0fe131cfbe2fd48/docs/architecture/sandbox-policy-and-execution.md). Merged-staging receipts: Acceptance / Cases run `42615261597` at `0173f403` (SC-02/03/04/05/07 on Ubuntu, SC-06 on `macos-15-intel`). Staging deployment patch: [patch-agent-sandbox.yaml](https://github.com/BestNathan/nession/blob/943e9e7f43265cbd7199c9979e6a8bf7d8f55f06/environments/staging/nession/patch-agent-sandbox.yaml) on the `gitops` branch. A trusted `when: deployed` Case lane remains pending.
- **Current tmux ownership:** [Session/tmux SDK ownership](https://github.com/BestNathan/nession/blob/dab5685f536722069e3c6c62ff112d8abae3e1a5/docs/architecture/session-tmux-sdk-ownership.md), where generic nession-tmux constructs tmux processes with an explicit private socket and Agent SessionService owns session policy.
- **Existing process discovery:** [Agent process discovery](https://github.com/BestNathan/nession/blob/dab5685f536722069e3c6c62ff112d8abae3e1a5/docs/architecture/agent-process-discovery.md) is read-only and intentionally does not create cgroups or grant resource control.
- **Historical OOM:** [#1286](https://github.com/BestNathan/nession/issues/1286) records an Agent-Pod OOM affecting multiple Sessions; the proposed on-demand Sandbox is **not** a complete fix for all Native Sessions or parent Pod limits.
- **Env boundary:** [#170](https://github.com/BestNathan/nession/issues/170) owns per-Session environment binding; Sandbox policy must not absorb that responsibility.
- **Agent-host Files is not this policy:** [#2751](https://github.com/BestNathan/nession/issues/2751) scopes Files to an explicit `FileSource`; the Agent's file root is only a browse root and absolute paths outside it remain reachable for terminal parity. The Files browser must not be cited as Sandbox confinement or as proof that a Session's view is isolated.
- **Terminal SDK:** [#2469](https://github.com/BestNathan/nession/issues/2469) owns shared tmux command/API boundaries.
- **External kernel mechanisms:** Linux [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html), [seccomp](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html), and [Bubblewrap](https://github.com/containers/bubblewrap). These establish mechanism semantics, **not** proof Nession currently implements them.

### Related knowledge

- [Web terminal emulator engine and component ownership](../terminal/web-terminal-emulator-engine-and-component-ownership.md) — xterm/terminal transport ownership stays separate from Sandbox process isolation.
- [Nession instruction architecture and knowledge ownership](nession-instruction-architecture-and-knowledge-ownership.md) — source and current-knowledge ownership rules.
- [Files capability identity, creation context and safe mutation ownership](../web/files-capability-identity-creation-context-and-safe-mutation-ownership.md) — Agent-host Files resolves and writes through an explicit source; its browse root is not a SandboxPolicy or isolation guarantee.

### Limits / when to revisit

Revisit if real macOS native capability changes; if a trusted native Rust backend can replace Bubblewrap; if Sandbox must become **enforced at Session scope**, including every Pane and all server-side tmux command paths; if authenticated ingress development-port publishing is required; or if runtime Case evidence contradicts these safety assumptions. Do not turn a proposed guarantee into a verified/implemented claim without an exact-source proof.

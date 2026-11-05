---
title: "Nession Sandbox policy and execution isolation architecture"
description: "Approved policy boundaries, native OS mechanisms, network domain controls, backend ownership, and persistent tmux execution constraints"
topic: engineering
categories: ["agent","architecture","sandbox","security"]
status: candidate
created_at: 2026-11-03T08:52:21.743Z
updated_at: 2026-11-05T10:32:06Z
sources: ["https://github.com/BestNathan/nession/issues/2681","https://github.com/BestNathan/nession/blob/dab5685f536722069e3c6c62ff112d8abae3e1a5/docs/architecture/session-tmux-sdk-ownership.md","https://github.com/BestNathan/nession/blob/dab5685f536722069e3c6c62ff112d8abae3e1a5/docs/architecture/agent-process-discovery.md"]
---

# Nession Sandbox policy and execution isolation architecture

## Decision and present status

**Owner decision, approved 2026-11-03:** Nession Sandbox is one **optional SandboxPolicy** with replaceable, capability-probed backends. Five policy groups are filesystem, network, process, resource, syscall. **Resource is a group inside SandboxPolicy**, not another product service, API, or independent runtime. Session Environment Binding is separate and remains owned by the Session. Sandbox is disabled by default.

**Implementation status: design approved, not shipped or verified.** This article is a detailed architecture proposal anchored to [Requirement #2681](https://github.com/BestNathan/nession/issues/2681). It MUST NOT be interpreted as evidence that the Sandbox backends, isolation guarantees, proxies, integration Cases, or resource controls are currently deployed. Current authoritative Session/tmux and process-discovery contracts remain in the linked repository architecture documents. Article status is **candidate** until implementation and source-aligned evidence justify promotion.

### Core execution boundary

    SessionService / SessionRegistry (Session lifecycle and optional policy reference)
      -> nession-sandbox (validate, probe, launch, own execution resources)
           -> Linux backend: Bubblewrap + delegated cgroup v2 + seccomp as requested
           -> macOS backend: verified native Seatbelt capabilities only
      -> nession-tmux (generic tmux process/typed command owner)
           -> one private shared tmux server -> Pane -> sandbox launcher -> shell/children

The shared tmux server does not enter a sandbox or its resource domain. No additional tmux server per Session is required. Browser attach/detach is not sandbox ownership; a running Pane and its execution may outlive WebSocket disconnection and Agent connection replacement. Nession's existing terminal transport, control lease, resize, replay and recovery semantics remain the controlling owners.

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
| filesystem.access | Bubblewrap mount view | Seatbelt path restrictions if verified |
| network allow/deny/restricted | Network Namespace plus trusted host proxy | Seatbelt restrictions plus trusted proxy if verified |
| process.linux_namespaces | PID/IPC/User/UTS/Cgroup Namespace (per request) | Unsupported |
| resource.cgroup_v2 | Kernel cgroup v2 with real delegation | Unsupported |
| syscall.seccomp | seccomp-BPF verified builtin profile | Unsupported |

macOS sandbox-exec is deprecated and should be treated as a version-probed, risk-documented dependency rather than an assured permanent public API. Process/file/network restrictions are mechanism-specific, not automatically equivalent to a Linux PID, Network or User Namespace.

## Evidence, validation and known limitations

- **Normative design owner:** [Requirement #2681](https://github.com/BestNathan/nession/issues/2681); implementation and exact Acceptance receipts are pending.
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

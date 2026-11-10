# Sandbox internal configuration IA — per-dimension management (#3143)

**Current owner:** https://github.com/BestNathan/nession/issues/3143  
**Base capability:** https://github.com/BestNathan/nession/issues/3124 (closed)  
**Resource native cgroup extension:** https://github.com/BestNathan/nession/issues/3141 (open)  
**Candidate direct HTML preview (publication SHA unverified):** https://bestnathan.github.io/nession/prototypes/sandbox-capability-3124/index.html  
**Owning source:** https://github.com/BestNathan/nession/tree/prototype/sandbox-capability-3124  

## User correction — what this prototype demonstrates

The Sandbox Home is an **information directory and execution-operation surface**, NOT a "three clusters + one inline editor" page, generic configuration panel, or independent policy builder. Five native policy dimensions each own their **own content model, management interactions, and Inside inspection**. Visiting one dimension opens a dedicated Sandbox-local detail view and returns to the Home via the Web breadcrumb/return control or **host-owned single App Back**.

\`\`\`text
Workspace / current Session / active Pane
└─ Sandbox Home
   ├─ Filesystem → lists of read-only / writable paths; add, edit, remove
   │                or Agent-prepared EROFS mounts (Inside read-only)
   ├─ Network    → mode + allowed/denied destination rule lists
   ├─ Process    → PID / IPC / USER / UTS / CGROUP namespace switches
   ├─ Resource   → Agent-discovered cgroup v2 controller files + native KV
   └─ Syscall    → Agent-registered seccomp profile selection and details
        ↳ All five share one canonical versioned Policy Draft
Sandbox Home → Validate → JSON review / Confirm Enter
Sandbox Inside Home → each dimension's **effective** detail → Return Native
\`\`\`

The **underlying canonical SandboxPolicy** stays owned by the Protocol/Agent. Module pages do not create independent persisted resources, update an already running Sandbox, or override runtime authorization. **Changing** a value invalidates preflight; **navigating** does not. Draft entry and current effective observation must not be confused.

## Independent configuration and inspection surfaces

| Section | Native (Outside) management | Inside / observed presentation | Notes |
|---|---|---|---|
| **Filesystem** | Workspace working directory, managed Read-only paths and Writable paths collections, Add/Edit/Remove for each entry | Effective authorized path collections, or Agent-prepared Base Runtime, Workspace and Toolchain mount targets | \`filesystem.access\` is not EROFS \`filesystem.composition\`. EROFS image digests/source paths are Agent/Server prepared and not client-editable |
| **Network** | Mode choice \`allow / deny / restricted\`; when restricted, separate allowed/denied target-list management | Mode and actually effective egress target lists, with backend observation/evidence | Ingress deny remains a backend/policy contract. Don't claim requested targets are already enforced |
| **Process** | Per-namespace toggles PID, IPC, USER, UTS, CGROUP, with CGROUP requiring USER | Verified installed namespace flags per current execution | Linux-only; macOS Seatbelt has different native semantics |
| **Resource** | Agent-discovered controller/file catalogue grouped by controller, choose filename → native Key/Value entry, Edit/Remove | Observed owned-cgroup applied/read-back native Key/Values | No four-key whitelist / per-value parsers in target #3141. Lifecycle pseudo-files such as \`cgroup.procs\` are not general Resource config |
| **Syscall** | Profile selector from Agent-registered available seccomp profiles; clear/select, profile description | Installed/verified profile and filter-loading evidence | Not a cgroup pseudo-file; no arbitrary syscall/BPF editor; currently only \`nession-interactive-v1\` |

**Homepage** presents five separate navigation rows with domain-specific count/status and one top-level operation group (Validate, Enter, and optional read-only combined Policy JSON preview). Each destination is its own view; there is **no inline editing on Home**. Opening a destination does not create a new global tab or a new app.

### Context and navigation

- In **Native**, module screens edit *draft* only. Return to Sandbox Home; all other modules retain their changes. The Home owns preflight and explicit Enter and shows the exact combined Policy payload.
- In **Inside**, identical destinations open *read-only effective* views; only Agent-authenticated execution and policy readback can prove actual installation. This prototype uses a synthetic mock to illustrate the desired state. Current scope is the selected Pane, not its shared tmux server, other Native Panes or all future Panes.
- In **macOS/offline/stale**, unsupported dimensions expose their status; never imply a Linux-native mechanism is available. No fabricated "Inside".
- **App 390/375** uses host-owned AppPageHeader/Back: Home → module → Back to Home; Confirm and Execution details keep their own depth; no duplicate module Back button on App. **Web 1180/1024** shows a Sandbox-local return link and standard Workspace Capsule. Long values wrap/stack.

### Review walkthrough

1. Choose **Native / 可进入**, navigate Terminal → Workspace → Sandbox. Home shows five navigation rows but no editable form.
2. Open **Filesystem**; Add a writable/read-only path, edit, remove and return. Open **Network**; choose mode then add/edit/delete a restricted allow/deny destination rule. Open **Process**; toggle namespace flags including UTS/CGROUP and test the CGROUP+USER preflight dependency.
3. Open **Resource**, inspect Agent-discovered controller/file candidates and click \`cpu.weight\`, \`memory.high\`, or \`io.max\` to create a native KV. Set the raw Value; remove a row or add another Key. **Syscall** has a separate seccomp Profile selector, not Resource-style KV fields.
4. Return Home. The summaries update. Expand **Policy JSON**, run **校验配置**, confirm **Enter** (the combined payload appears there), and observe the new Inside Home. Opening any dimension now shows only effective read-only detail. Switch back to Native.
5. Change fixtures: \`EROFS 已组合\` → Filesystem shows sanitized \`/\`, \`/workspace\`, \`/opt/rust\` targets read-only; \`仅 Memory/PIDs 委派\` removes CPU/IO suggestions; macOS prevents Linux-native settings; offline hides Enter; kernel write error shows fail-closed rollback.
6. Switch Web 1180/1024 ↔ App 390/375; confirm one App header/Back, appropriate scroll/field wrapping, no duplicated global navigation.

## Source ownership / architecture boundaries

- Production Web: \`web/src/capabilities/sandbox/components/SandboxComposer.tsx\`, \`SandboxInsideView.tsx\`, \`SandboxEffectivePolicy.tsx\`, the existing field/KV and draft components. #3143 modifies **composition and navigation**, not the Sandbox's execution backend.
- Protocol: \`crates/nession-protocol/src/contracts/sandbox/v1.rs\` is the single schema owner; #3141 separately targets native cgroup KV support.
- Runtime: \`crates/nession-sandbox/src/{policy,exec,capabilities}.rs\`; \`crates/nession-agent/src/sandbox_runtime.rs\` authoritative for current Pane and effective execution.
- Prepared EROFS composition: #3024 / #3062. The Web draft may not edit internal image sources/digests.
- Shared visual recipes: #3137 (detail/configuration/operation grammar); real Design Gate evidence: #3138. Maintain existing tokens, Workspace navigation/Capsule and App Back.

## Mock fidelity, verification and limitations

- This is **standalone synthetic HTML/JS**. It makes no API calls and cannot launch a real tmux Pane, create cgroups, load seccomp, validate filesystem mounts or prove Agent execution.
- The Native Path/Network mock internally serializes collection values via comma-joined draft fields before projecting the wire Policy; production must use typed path/rule arrays from the canonical contract, not this simplified mock representation.
- Inside readback and EROFS mount targets are synthetic fixtures. A running kernel might reject a native cgroup Value even after UX preflight; Agent writes and exact OS errno determine actual success.
- A profile's availability in the mock is not evidence a seccomp filter was installed. Offline/unsupported state, controller delegation and Agent generation are also fixtures.
- **Corrected IA synthetic regression (2026-11-10): 42/42 V8 synthetic-DOM assertions passed** against the five-destination app.js/index.html revision. Tests exercise Home-only navigation, all five dedicated module views, Filesystem path add/edit/remove, Network mode + allow/deny rule add/remove, Process UTS/CGROUP and USER dependency, native Resource file discovery/selection/raw values, seccomp Profile select/clear, cross-module draft persistence, preflight invalidation/validation, combined confirmation/Enter, Inside per-module read-only projection, Native return, prepared EROFS mounts, limited delegation, macOS/offline safety states, and Web/App single Back. JS parsed without syntax errors. These are **deterministic mock checks, not Chromium, kernel, deployment, or real accessibility evidence**.
- Historical smoke results (28/28, 12/12, 23/23, 32/32) target superseded prototypes and are not acceptance proof for the corrected information architecture.
- Public Pages deployment and manifest SHA remain unverified. This source directory/commit is authoritative for the prototype revision.

**Non-goals:** independent Sandbox module apps, separate persistence for each dimension, in-place modification of active Sandbox policy, arbitrary host cgroup writes, untrusted BPF upload, self-managed EROFS registry or a new design-system primitive library.

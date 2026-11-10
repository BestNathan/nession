# Sandbox capability — compose draft, Enter, inspect effective execution (#3143 / #3124)

**Current composition design:** https://github.com/BestNathan/nession/issues/3143  
**Base execution behavior:** https://github.com/BestNathan/nession/issues/3124  
**Candidate HTML preview (public Pages revision NOT VERIFIED):** https://bestnathan.github.io/nession/prototypes/sandbox-capability-3124/index.html  
**Source directory:** https://github.com/BestNathan/nession/tree/prototype/sandbox-capability-3124  
**Related:** #3141 (native cgroup v2 Resource KV), #3137/#3138 (shared capability visual grammar and design gate), #3024/#3062 (prepared EROFS composition), #2681 (native Sandbox backend), #1347 / #1455 (Workspace Capsule).

## Corrected product contract — 2026-11-09

**Sandbox is a context-sensitive, actionable Session/Pane capability**, not a read-only Agent status monitor.

1. **Current active Pane inside a verified, Nession-managed Sandbox** → Show `Inside Sandbox`, **observed effective policy** (Filesystem, Network, Process, Resource, Syscall), backend, mechanisms and execution identity. The policy is read-only; it is not the last user-edited draft. Provide `Return to Native Pane` as a focus switch, not a kill.
2. **Current active Pane outside / Native** → Show `Outside Sandbox`, editable native-versioned Policy draft, `Validate Policy` preflight, explicit `Enter Sandbox` confirmation. Success creates a **new isolated Pane in the same logical Session**, verifies mechanisms before running the new shell, focuses it, and retains the original Native Pane untouched. The real runtime mechanism is not yet implemented in staging #2681.
3. **Agent offline, unsupported backend or Session instance mismatch** → Precise error/unverified state and no enabled Enter. A previous execution report is not proof that the current Pane is inside.
4. **Failure** → Refuse operation with a concrete error, preserve draft and Native Pane; never silently fall back to Native while claiming Enter succeeded.
5. **Supported host != inside**. Same Session may contain both Native and Sandbox Panes; presence is per active Pane and durable instance/execution identity, not simply Agent support or Session name.

## Baseline and ownership

Source-based layout baseline: `staging`, 2026-11-09.
- `web/src/app/experiences/web/WebLayout.tsx`, `ShellMain.tsx`, `WorkspacePanel.tsx`, `WorkspaceShell.tsx`, `CapabilityCapsule.tsx`, `design/generated/web.css`.
- `web/src/app/experiences/app/AppLayout.tsx`, `AppLayers.tsx`, `docs/design/interaction/app.md`, `docs/design/design-system/patterns/workspace-navigation.md`.
- `crates/nession-sandbox/src/{exec,policy,capabilities}.rs`, `crates/nession-agent/src/sandbox_runtime.rs`, `crates/nession-protocol/src/contracts/sandbox/v1.rs`, `docs/architecture/sandbox-policy-and-execution.md`.

**Web DOM owner:** `WebLayout → Sidebar + ShellMain → WorkspacePanel → WorkspaceShell → Sandbox capability-local view`. The sidebar owns Session selection; the Workspace capsule and Terminal destination circle remain shell-owned. Sandbox only owns its config/detail content.

**App DOM owner:** `AppLayout/AppLayers (Sessions ← Terminal → Workspace) → WorkspacePanel host-owned single AppPageHeader/Back → WorkspaceShell + Sandbox local root/confirmation/detail`. App has one Back at every pushed level and the Capsule in the bottom zone (no new Workspace `+` menu). Back on confirmation cancels the action without applying the draft; Back on detail returns to Sandbox root; Back on root returns to Terminal.

**1:1 geometry:** review frame uses real CSS px (Web 1180/1024, App 390/375) and no transform/zoom. Prototype product contents use Nession semantic color token snapshot; terminal character density, shell pixel parity and native touch/safe-area behavior remain approximations until real browser/fixture comparison.

## Critical clickable journey

1. In the default **Native** fixture, open Workspace from Terminal and select Sandbox. UI says **Outside Sandbox** and shows an editable Policy composer, not a diagnostic-only status view.
2. Set working dir, filesystem paths, network mode/egress and namespaces. **Resource** and **Syscall** start with zero rows. Resource Key suggestions come from an **Agent-owned child-cgroup native file scan** (the prototype uses synthetic scan responses), including `cpu.weight`, `memory.high`, `memory.low`, `io.max` and earlier common fields when actually exposed by delegated controllers; Nession's fixed four-key parser is **not the target contract**. Value stays literal Linux text. Syscall is a separate pinned profile registry, currently `seccomp.profile = nession-interactive-v1`; it is not a cgroup file.
3. Click `校验配置` to check generic empty/duplicate Key/Value, a single safe native file basename, current Agent candidate presence, and pinned seccomp profile—**not application-defined parsing of `cpu.max`, `memory.max`, `io.max` or any other kernel value**. Missing controller, lifecycle file (`cgroup.procs`) or read-only file are rejected by discovery/Agent. Kernel validates values only when writing them in a newly created managed child cgroup, before processes are launched; errors fail closed and clean up. Edits invalidate prior preflight.

4. Click `Enter Sandbox` → separate confirmation screen explains new Pane + original Native preservation → confirm.
5. Successful mock transition shows `Inside Sandbox` and **effective policy** (copy committed at simulated verification), then `Execution details` (backend, execution/pane identity, digest, evidence). Return from details, then `返回 Native Pane`; original Native context resumes; the Sandbox Pane remains available for `切回已有 Sandbox Pane`.
6. Switch external fixtures: `active` (already inside), `preflight-fail` (kernel controllers not delegated), `enter-fail` (launch barrier rejects), `offline`, `unsupported`, `macos`, and `recreated` (stale instance id); verify no fake protected badge, no auto-fallback, retained draft.
7. Switch Web 1180 → App 390 → Web 1180, plus App 375. Confirm the actual product composition changes, current scope remains selected, one App header/Back, bounded scroller and scroll clearance.
8. In Web Sidebar (or App Sessions), select the Native and Sandbox fixture Sessions to observe context-dependent discovery; return to Terminal without changing process state.

## Mock scenario matrix

| Fixture | Active Pane | Visible action | Expected |
|---|---|---|---|
| Native / can enter | Native | Compose → Preflight → Enter | Success switches to new verified Sandbox Pane |
| Already in Sandbox | Managed Sandbox | View effective policy → details / Return to Native | Does not offer duplicate Enter |
| Limited delegation | Native | Agent-discovered Resource list excludes `cpu.max` | Key list follows delegated controller capabilities |\n| Preflight fail | Native | Edit → Validate | Capability error blocks Enter |
| Launch fail | Native | Validate → Confirm Enter | Refuses, Native and draft unchanged |
| Agent offline | Unknown | Read-only explanation, retained draft | No Enter / false inside |
| Unsupported | Native/Unknown | Explanation (previous view can remain open) | Capsule has no unavailable slot |
| macOS Seatbelt | Native | Network deny / allowed subset, Resource/Syscall KV add disabled | Linux-only controls are unavailable; no assumed fallback |
| Same-name recreated | Unknown (unverified) | No Enter until identity re-established | Old report never reused |

### Native cgroup v2 Resource KV pass-through (#3141)

The native policy is a map: `resource: { cgroup_v2: {"cpu.weight":"100", "memory.high":"1073741824", "io.max":"8:0 rbps=10485760"}}`. An empty Resource group is omitted. Values are native strings, and the Linux kernel (not the frontend or Nession Rust compiler) validates their native syntax during writes.

- **Discovery:** the Agent inspects available delegated controllers and actual control files of an Agent-owned child cgroup. The UI can suggest any discovered **configurable resource-controller** file, not merely the former four fields. `cpu.weight`, `memory.high`, `io.max` appear in this synthetic prototype's full-host scan; the `仅 Memory/PIDs 委派` scenario drops CPU and IO knobs. A file's presence is not proof an arbitrary value will be accepted.
- **Security/lifecycle:** a normal Resource KV must target a single basename inside the new execution-owned cgroup, not arbitrary filesystem paths, parent limits, or other Sessions. Runtime manages `cgroup.procs`, `cgroup.threads`, `cgroup.kill`, `cgroup.freeze` and `cgroup.subtree_control`; these are **not** editable Resource values. Read-only status files are also not suggested. No per-field resource unit translation or hardcoded value parser.
- **Native application:** prelaunch Agent writes each value to the real kernel cgroup file, reports any kernel errno/file on failure, deletes newly owned resources after failure, and never starts an unrestricted process as a fallback. The prototype's **内核写入失败** fixture only simulates that rejection and Native preservation.
- **Syscall distinction:** same empty-first KV row interaction, but `syscall.seccomp.profile` is a pinned Agent-registered seccomp profile, **not** a file in cgroup v2. This ticket does not introduce arbitrary seccomp filtering.
- **Mock limitation:** `agentFieldCatalog()` returns synthetic child-scan data; no real Agent, kernel scan, write or runtime isolation occurs when using this HTML.

## Policy Composition — five dimensions, three clusters (#3143)

**Goal:** the Sandbox Workspace is one coherent composition of the execution environment, isolation boundary, and execution controls, not five disconnected forms. This UI is a projection of **one canonical policy**, not a second schema or config engine.

| Visual group | Member | Draft/Inside interpretation |
|---|---|---|
| 执行环境 | Filesystem | host-path access OR Agent-prepared EROFS root; distinguish access vs composition |
| 隔离边界 | Network | allow / deny / restricted, explicit mode and egress |
| 隔离边界 | Process | native namespace requests vs actually installed namespaces |
| 执行约束 | Resource | Agent-discovered cgroup v2 native Key/Value, unchanged by Nession |
| 执行约束 | Syscall | independent Agent-registered seccomp profile |

### Outside Sandbox (editable)

1. Open `Workspace → Sandbox`: the first section shows three groups and five **request-state** rows (`已申请`, `未申请`, `当前不可用`). No host capability alone is labeled "already inside".
2. Click a row: a **single focused group editor** appears, preserving all five groups' shared draft. Defaults to Filesystem. Resource and Syscall retain empty-first add/edit/remove; Resource Value stays kernel-native.
3. Expand `查看组合 Policy JSON` to inspect the read-only assembled versioned policy. Optional empty groups are **omitted** (including empty Filesystem/Process), not fabricated into Linux restrictions. The JSON derives from the draft projection used for preflight, not an independently editable source.
4. Switching among groups changes only focus; **editing values** invalidates preflight. Confirm Enter shows the full composite Policy JSON plus target Native Pane/Agent and mock capability generation. No silent drop of an unavailable group.

### Inside Sandbox (observed, not editable)

1. Reuse the same three-cluster composition overview, but statuses and details are sourced from **simulated Agent-observed effective policy**, not draft changes. The mock says `示例已生效`, not generic "protected."
2. Preserve the active Pane-only scope: Native Pane, shared tmux server and future panes remain outside this execution. `Execution details` holds backend/identity/evidence. Return to Native is a focus switch only.
3. The **`EROFS 已组合` fixture** illustrates the alternative filesystem input: a read-only Base Runtime at `/`, Project/workspace view at `/workspace`, and toolchain image at `/opt/rust`. The UI displays only sanitized mount targets. It does **not** offer editable EROFS image source paths/digests or fake a complete raw policy JSON; prepared EROFS is Agent/Server-owned and mutually exclusive in effect with regular filesystem.access.
4. Other fixtures: native full controller discovery, limited Memory/PIDs delegation, macOS unsupported native Resource/Syscall, offline/unknown, kernel reject after preflight. Group status never substitutes for Agent runtime proof.

**Layout:** Web 1180/1024 uses whitespace-first grouped summaries with one focused edit area. App 390/375 stacks rows and fields, keeps a single App Back and the Workspace Capsule, and uses the same state semantics. Follow the shared detail/form visual recipe in #3137; #3138 owns real browser gate evidence.

**Verification (2026-11-10):** **32/32 V8 synthetic-DOM assertions passed** against the composition + prepared EROFS prototype revision: all five dimensions/three clusters, focused editing, KV persistence across groups, preview/optional omission, no preflight reset on focus alone, preflight reset on edit, confirmation canonical JSON, Inside read-only representation, Native return, prepared EROFS mount view with no fake raw JSON, limited delegation, macOS/offline and Web/App shell transitions. **Synthetic checks are not Chromium screenshots, real Agent capability reads, cgroup writes, EROFS mounts, or published Pages verification.**

## Verified and unverified

**Fidelity:** synthetic in-page JavaScript fixtures; no network calls, backend writes, durable storage, active tmux PIDs, cgroup resources, Bubblewrap, Seatbelt, Socket proxy, native policy compiler or process reparenting. Clicking Enter only simulates a backend command; this standalone mock never invokes the current production Agent. Read-only effective policy is also synthetic and illustrates the **post-verification** display shape, not proof that a real Agent returned it.

**Native cgroup KV regression (2026-11-10):** **23/23 V8 synthetic-DOM checks passed** for the new Resource prototype: discovered `cpu.weight`, `memory.high`, `io.max` and more-than-four candidates, empty-state policy omission, add/edit/Enter/effective readback, reduced delegation exclusion, lifecycle/read-only file rejection, kernel-native whitespace value preservation, simulated kernel `EINVAL` after preflight with unchanged Native Pane, macOS/offline status, Web/App switching, and issue/fixture links. This is deterministic mock behavior **only**, not Chromium, real cgroup2 native write tests, or Pages publication proof.

**Historic prototype smoke:** The earlier 28-case / 12-case V8 synthetic-DOM tests targeted the prior **four-key whitelist** versions and are superseded for Resource semantics. The current revision uses an expanded synthetic native file catalog with kernel-write error fixture. New exact-revision checks should be recorded separately; no real browser/native runtime evidence is claimed.

**Pages publication:** the direct HTML link above is a *candidate*, not proven live with the revised source. Verify `/nession/prototypes/manifest.json` equals exact source commit and read back the public HTML before calling it current.

## Distinct non-goals
No new Project, Environment Binding, EROFS resource, independent Workspace Location, global Sandbox page/tab, whole-Session confinement, policy hot-reload, opaque shell command injection, or simulation of actual native security. The earlier #3124 Enter workflow and its acceptance are separate from the *new* native Resource KV requirements tracked by #3141.
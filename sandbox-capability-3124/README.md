# Sandbox capability — inspect current context, or configure and Enter (#3124)

**Owner:** https://github.com/BestNathan/nession/issues/3124  
**Candidate HTML preview (public Pages revision NOT VERIFIED):** https://bestnathan.github.io/nession/prototypes/sandbox-capability-3124/index.html  
**Source directory:** https://github.com/BestNathan/nession/tree/prototype/sandbox-capability-3124  
**Related:** #2681 (native Sandbox backend), #1347 / #1455 (Workspace Capsule), #3062 (Managed EROFS Session creation).

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
2. Set working dir, read/write filesystem path sets, network mode and egress allow-list, Linux namespace flags, cgroup v2 `memory.max`/`pids.max`, and pinned `nession-interactive-v1` seccomp profile. MacOS fixture hides/disables Linux-only inputs and uses measured Seatbelt subset; `enforcement: required` is fixed.
3. Click `校验配置` to validate draft. Errors block Enter; edits invalidate the prior preflight. This mock performs **synthetic checks only**, not actual filesystem capability probes.
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
| Preflight fail | Native | Edit → Validate | Capability error blocks Enter |
| Launch fail | Native | Validate → Confirm Enter | Refuses, Native and draft unchanged |
| Agent offline | Unknown | Read-only explanation, retained draft | No Enter / false inside |
| Unsupported | Native/Unknown | Explanation (previous view can remain open) | Capsule has no unavailable slot |
| macOS Seatbelt | Native | Network deny / allowed subset, Linux-only controls disabled | Restricted/specific Linux controls not promised |
| Same-name recreated | Unknown (unverified) | No Enter until identity re-established | Old report never reused |

## Verified and unverified

**Fidelity:** synthetic in-page JavaScript fixtures; no network calls, backend writes, durable storage, active tmux PIDs, cgroup resources, Bubblewrap, Seatbelt, Socket proxy, native policy compiler or process reparenting. Clicking Enter only simulates a successful *future* backend command. Read-only effective policy is also synthetic and illustrates the **post-verification** display shape, not proof that a real Agent returned it.

**Verification status (2026-11-09):** GitHub source and generated JavaScript syntax inspected; **26/26 V8 synthetic-DOM assertions passed** on the revised files: Native default, policy input, validation/cancel, Enter confirmation/success, effective readback, execution detail, Return to Native, switching back to the existing Sandbox, launch and capability failure, invalid working directory, offline/unsupported/stale states, macOS disabled native fields and supported subset, App single header, Web↔App and Terminal return, plus gallery/frame links. These deterministic tests do **not** constitute browser or runtime evidence. Prior revision's `17/17` assertions are superseded. Real Chromium/Playwright screenshots, keyboard/focus, true CSS width/scroll, fixture pixel parity, native runtime/authorization and publication manifest SHA are **not verified** by source or synthetic DOM tests.

**Pages publication:** the direct HTML link above is a *candidate*, not proven live with the revised source. Verify `/nession/prototypes/manifest.json` equals exact source commit and read back the public HTML before calling it current.

## Distinct non-goals
No new Project, Environment Binding, EROFS resource, independent Workspace Location, global Sandbox page/tab, whole-Session confinement, policy hot-reload, opaque shell command injection, or simulation of actual native security. Production needs a new trusted Agent/Server Enter operation and per-Pane execution lifecycle; those remain Pending in #3124.
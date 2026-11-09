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
2. Set working dir, filesystem paths, network mode/egress and namespaces. **Resource** and **Syscall** start with zero rows: click **＋ 添加条目** to add Key/Value pairs or remove them; no `cpu.max`, `memory.max`, `pids.max` or profile is preselected. Resource key suggestions (not silent acceptance): `memory.max`, `cpu.max`, `pids.max`, `memory.oom.group`, with native Linux values. Syscall uses the same KV editor, but the current wire supports only `seccomp.profile = nession-interactive-v1`—not arbitrary syscall filtering or user-provided BPF. MacOS disables both Linux-native groups, and `enforcement: required` stays fixed.
3. Click `校验配置` to validate the draft. Empty Resource/Syscall groups **omit** `resource.cgroup_v2` / `syscall.seccomp` rather than serializing empty objects. For each added pair, reject unknown Key, empty Key/Value, duplicate Key and malformed native Value: `memory.max`/`pids.max` use uint64 or `max`; `cpu.max` uses `quota period` with period 1000–1000000 microseconds; `memory.oom.group` is `0` or `1`; `seccomp.profile` accepts only the pinned profile. Edits and row add/remove invalidate prior preflight. The mock performs **synthetic checks only**—the Agent must still validate real host capabilities before Enter.
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

### Agent-discovered field catalog (design revision)

Resource and Syscall KV candidate keys are **not intended as frontend-maintained hardcoded lists**. The Agent must return a typed capability catalog scoped to the selected host/location, probe generation, backend and actual delegated execution root:
- **Linux Resource:** read `cgroup.controllers`, probe delegated `cgroup.subtree_control` and **child cgroup control files**, then intersect actually installable files with the V1 protocol allowlist. Return key, native value-format help, availability/reason; validate again at Enter. Host visibility alone is not sufficient proof of writable delegation.
- **Syscall:** discover installed **Agent-registered profiles** and probe kernel/Bubblewrap seccomp loadability. The V1 registered profile is `nession-interactive-v1` at key `seccomp.profile`. Linux syscall names/numbers (which may be exposed for read-only profile explanation) are **not arbitrary configurable filters**.
- **macOS/offline:** no Linux-native Resource/Syscall keys available; for offline, status is unknown, not a confirmed empty kernel feature set.
- **Current prototype:** `agentFieldCatalog()` returns **synthetic Agent fixture responses, not live OS data**. Select `仅 Memory/PIDs 委派` to see `cpu.max` disappear from the candidate list, or `macOS Seatbelt` for no Linux-native choices. The production UI will consume a real authenticated Agent catalog and must not depend on these fixture literals.
- **Validation:** key suggestion is a convenience; final compilation and launch verification must remain Agent-authoritative, with unknown/duplicate/invalid keys rejected and no fallback.

### Resource and Syscall wire mapping (UI shape ≠ unrestricted policy)

- **Resource editor** is an empty list of `{key,value}` until the user adds rows. Only the four V1 cgroup v2 control-file keys above may be serialized. The actual nested request maps to `resource: {cgroup_v2: {"cpu.max":"200000 100000"}}`, while a blank list **omits** `resource`.
- **Syscall editor** uses the same row interaction but maps exactly `seccomp.profile` to `syscall: {seccomp: {profile:"nession-interactive-v1"}}`. Unknown KV keys or profiles fail closed. Empty list **omits** `syscall`; this does not disable the Linux backend's always-on baseline seccomp.
- Values are strings in their **native kernel syntax**; no unit/core conversion, no permissive passthrough of unknown keys, and no independent UI-owned schema. Agent host validation remains authoritative after mock validation.
- The current **Inside** fixture may show effective Resource/Syscall rows (as read-back examples); this is distinct from the **Outside** initial draft, which has no rows.

## Verified and unverified

**Fidelity:** synthetic in-page JavaScript fixtures; no network calls, backend writes, durable storage, active tmux PIDs, cgroup resources, Bubblewrap, Seatbelt, Socket proxy, native policy compiler or process reparenting. Clicking Enter only simulates a successful *future* backend command. Read-only effective policy is also synthetic and illustrates the **post-verification** display shape, not proof that a real Agent returned it.

**Verification status (2026-11-09, see latest pinned Issue):** GitHub source and JavaScript syntax inspected; **28/28 V8 synthetic-DOM assertions passed** for the KV revision: default Native with empty Resource/Syscall, optional-field omission, Add/Remove, empty-row rejection, `cpu.max` quota/period parsing and period-range rejection, duplicate/unknown key rejection, invalid seccomp profile, valid nested `syscall.seccomp.profile` mapping, Enter and effective readback of KV values, Native return, macOS groups disabled, failed preflight/launch, and Web/App responsive state. These are **synthetic checks, not real browser or native runtime evidence**. Previous `17/17` and `26/26` smoke results are superseded by this revision. Real Chromium/Playwright, keyboard/focus, true CSS-pixel layout/scroll, fixture pixel parity, native runtime/authorization, and publication manifest SHA remain **unverified**.

**Latest Agent-discovery regression (2026-11-09):** **12/12 V8 synthetic-DOM assertions passed** on the catalog-aware revision: full-host 4 Resource choices plus registered Syscall profile, limited delegation removes `cpu.max` and rejects manually typed CPU control, macOS has no Linux-native keys, offline reports unknown, Native no optional entries, and Enter/Return semantics still work. The 28-case KV smoke was run on the preceding version, not automatically re-run against this exact revision. Both sets are **synthetic mock checks only**.

**Pages publication:** the direct HTML link above is a *candidate*, not proven live with the revised source. Verify `/nession/prototypes/manifest.json` equals exact source commit and read back the public HTML before calling it current.

## Distinct non-goals
No new Project, Environment Binding, EROFS resource, independent Workspace Location, global Sandbox page/tab, whole-Session confinement, policy hot-reload, opaque shell command injection, or simulation of actual native security. Production needs a new trusted Agent/Server Enter operation and per-Pane execution lifecycle; those remain Pending in #3124.
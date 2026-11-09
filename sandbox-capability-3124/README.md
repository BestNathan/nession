# Sandbox capability in Workspace — interactive prototype (#3124)

**Owning Requirement:** https://github.com/BestNathan/nession/issues/3124  
**Related:** [Sandbox runtime #2681](https://github.com/BestNathan/nession/issues/2681), [Capability model #702](https://github.com/BestNathan/nession/issues/702), [Capsule V2 #1347](https://github.com/BestNathan/nession/issues/1347), [Managed Session #3062](https://github.com/BestNathan/nession/issues/3062).  
**Direct HTML candidate URL (not publication proof):** https://bestnathan.github.io/nession/prototypes/sandbox-capability-3124/index.html  
**Source:** `prototype/sandbox-capability-3124/`; immutable commit/published SHA recorded in owning Issue after verification.

## Scenario / fidelity contract (2026-11-09)

### Question and purpose
Can Nession distinguish Agent/Location support from a **particular Session's verified on-demand initial-Pane Sandbox execution**, then make this a discoverable, context-sensitive Workspace capability without inventing another shell or implying whole-Session confinement?

**Product surface:** full Web shell and App spatial layers for a selected Session. Review-page harness uses [prototype-frame-2758](../prototype-frame-2758/README.md). Candidate content is **Sandbox's capability-specific read-only Workspace view**; global navigation remains existing Capsule V2.

**Source baseline:** staging 2026-11-09:
- `web/src/app/experiences/web/WebLayout.tsx` → Sidebar + ShellMain → WorkspacePanel → WorkspaceShell;
- `web/src/app/experiences/app/AppLayout.tsx`, `AppLayers.tsx` → Sessions ← Terminal → Workspace; `WorkspacePanel` owns one `AppPageHeader` per depth;
- `web/src/app/workspace/{WorkspaceShell,CapabilityCapsule,capabilities,viewBindings}.tsx`, `web/src/product/workspace/patterns/workspaceNavigationStyles.ts` → bounded horizontal scroll, no Workspace More/`+`, unavailable hidden;
- `docs/design/{workspace,capability-emergence,interaction/web,interaction/app}.md`, `docs/design/design-system/patterns/workspace-navigation.md`, `design/generated/web.css`;
- `crates/nession-protocol/src/contracts/sandbox/v1.rs` and `crates/nession-agent/src/sandbox_runtime.rs` (staging-only native implementation).

**Owner hierarchy demonstrated:**
- Web root/terminal: `WebLayout → Sidebar + ShellMain → Terminal`; controls: Sidebar Session selection, Terminal composer +, Workspace destination circle.
- Web Workspace: `WebLayout → Sidebar + ShellMain → WorkspacePanel → WorkspaceShell → Sandbox`; controls: Terminal destination circle + one Workspace capability capsule; Sandbox owns only its own read-only details button.
- App Terminal: `AppLayout/AppLayers → Terminal → composer` with Sessions/Workspace visible destination controls.
- App Workspace root: `AppLayers → WorkspacePanel/AppPageHeader(Back) → WorkspaceShell → Sandbox`; controls: **one** Back and the bottom Capsule.
- App pushed detail: same host AppPageHeader titled `Execution details`, same bottom Capsule and detail content; Back pops to Sandbox root, then Back returns Terminal.
- Web↔App: one simulated Session identity and shared capability state; simulated product mode driven by `np:resize` emitted from the actual review device, never the surrounding browser width.

### Entry and critical path
1. Initially show a quiet Terminal and its Conversation capsule: **no permanent Sandbox work ring or fake secure badge**. Open Workspace using the visible destination. The Sandbox capability becomes discoverable in the Capsule if supported.
2. Select Sandbox and inspect a real-shape (mock) observed status: supported Agent is **not** sufficient to mark a Session isolated; the headline says on-demand initial Pane.
3. Open verified execution details. Inspect backend, mechanisms, policy digest, execution id, instance id, warning/limits and a deliberate scope limitation. Return without changing the runtime.
4. Change fixture to Native, offline, unsupported, recreated Session, partial; verify no old execution id is reused, offline stays unknown, unavailable loses its navigation slot but currently opened explanatory view remains.
5. Switch Web 1180 → App 390 → Web 1180 and App 375; verify real layout-mode changes and matching contextual Session return. On App, pushed detail has one host-owned Back and Capsule remains at the bottom at all depths.
6. In Web Sidebar (or App Sessions), select `native-debug` and return to `sandbox-review`; the selected Session determines the apparent execution facts.

### States
- `active`: native Linux backend + verified on-demand SandboxExecution; standard policy dimension summary and details.
- `native`: host supports Sandbox but current Session has **no** SandboxExecution; supports discoverable, not 'active protected'.
- `offline`: Agent unreachable, previously known capability but current live state not established; read-only explanation.
- `unsupported`: host cannot install a backend; Sandbox **not** in Workspace capsule; a previously opened explanation may stay until user changes capability.
- `recreated`: same-named Session incarnation changed; old report rejected; no verified effective policy.
- `partial`: initial Pane verified, later Window/Pane not guaranteed and must not inherit a whole-Session label.

### Visual / interaction decisions
- UI stays within Nession's existing shell, Capsule navigation and generated token vocabulary; no separate Sandbox global sidebar, tab, dashboard, Workspace + menu, or location.
- Web has broad content, two-column fact grid and deliberate local details disclosure; App has one-column content, 44px Capsule slots, host Back on push, scroll clearance.
- At rest Terminal remains quiet; explicit '+' may show a small Session-scoped Peek, which offers a direct Workspace destination for meaningful Sandbox context.
- Sandbox is read-only for this Requirement. Creation / Policy editor is **not modeled as a shipping UI** and remains a separate interaction decision; Managed EROFS is #3062.

### Fidelity classification
| Input/behavior | Source | Fidelity |
|---|---|---|
| Agent, Session, name, backend, Policy digest, execution id | Static synthetic fixture | mock |
| State transitions and Capsule visibility | In-browser JS | mock |
| Web/App shell ownership and Capsule shapes | staging code and canonical design source inspection | source-informed approximation |
| RootFS, namespace, seccomp, cgroup, policy authorization, tmux continuity | no runtime connected | **not tested** |
| Agent capability detection, backend/report/Server protocol | no runtime connected | **not tested** |
| DOM interactions, scroll, focus, device widths | browser verification status recorded separately | awaiting proof |

All product data and IDs are synthetic and contain no private endpoints or secrets. Colors are a **scoped local snapshot** from staging `design/generated/web.css`; the actual React UI / xterm terminal text, font fitter, safe-area geometry and precise pixels may differ. Do not claim 1:1 visual or xterm parity: the 1:1 label refers only to CSS pixel viewport dimensions.

### Checks / verification
- Source and catalog files on the shared `prototype` branch are verified through the GitHub connector.
- The proposed direct HTML path is not automatically evidence of Pages deployment. **Do not claim live publication until `/nession/prototypes/manifest.json` SHA agrees with the remote commit and its HTTPS HTML is checked.**
- **Authoring smoke (2026-11-09):** GitHub sources fetched; standalone JS parsed as valid JavaScript; 17/17 deterministic V8 synthetic-DOM assertions passed (initial Terminal, Workspace entry, scoped execution copy, detail open/return, Native/offline/unavailable/recreated/partial negative states, App one-header depth, App→Web mode roundtrip, Terminal return, gallery/catalog links). This is not Chromium and does not prove layout pixels, real focus/scroll or backend security.
- **Remaining:** real Chromium desktop/mobile click-through, viewport geometry, stage left/right edge reachability, actual focus/scroll, console/network, screenshots and actual React fixture side-by-side. No existing #3025 browser record proves this prototype.
- Production Acceptance/E2E is independent and remains Pending in #3124.

## Non-goals
No new global navigation owner, policy hot edit, Agent SDK change, EROFS image mount/download, enforced Session guarantee, persistent mock storage, network request or real Sandbox invocation.
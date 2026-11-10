# Sandbox Strategy Tabs — Web/App information architecture (#3143)

**Owning Requirement:** https://github.com/BestNathan/nession/issues/3143  
**Related:** #3161 (per-native-policy support discovery), #3124 (Sandbox Pane/Enter/Inspect), #3141 (native cgroup v2 Resource KV), #3137/#3138 (shared visual recipes/design gate), #3024/#3062 (prepared EROFS).  
**Candidate direct Pages HTML (latest publication unverified):** https://bestnathan.github.io/nession/prototypes/sandbox-capability-3124/index.html  
**Prototype source:** https://github.com/BestNathan/nession/tree/prototype/sandbox-capability-3124

## Corrected distinction: five **independent** configuration panels, no five route depths

Keep the five independently managed domain panels, but place them under **one Sandbox capability page with six peer strategy Tabs**:

```text
Workspace → Sandbox (single capability route, current Session/Pane)
  ├─ Overview    — current context, policy summaries, validate/Enter/inspect
  ├─ Filesystem  — RO/RW path list management, or effective prepared EROFS mounts
  ├─ Network     — network mode + allow/deny target rule management
  ├─ Process     — native Linux namespace switches
  ├─ Resource    — Agent discovered native cgroup v2 files + raw KV editor
  └─ Syscall     — Agent registered seccomp profile select/details
```

**Web:** the left strategy-tab navigation remains visible, while the selected independent policy panel occupies a wide, vertically scrollable area. No `Sandbox Home → Module → Back → Next Module` navigation. A large Resource/Network/Filesystem section has its own scrolling editor and remains usable without losing navigation.

**App:** six horizontally scrollable Tabs just under the existing single App header; the selected policy panel uses the full available width with vertically scrollable content. Switching strategy is one tap or tab-keyboard navigation, **not a new route/history entry**. The host Back still leaves Sandbox/Workspace. Confirm and Execution Details keep their own temporary depth, and Back restores the previously selected strategy Tab.

**Shared state:** only one native versioned Policy Draft. Tab selection does not invalidate preflight or discard data; actual edits across any of the five panels do. A read-only Policy JSON preview and global Validate/Enter operations live in Overview, not inside every panel.


## Native policy implementation discovery (Requirement #3161, mock vNext)

**New contract owner:** https://github.com/BestNathan/nession/issues/3161. **This prototype is a future protocol/UI design**, not a claim that the existing V1 Agent implements `catalog_version: 2`. The current staging V1 `SandboxCapabilityCatalog` exposes an overall state and two flat `resource_fields` / `syscall_fields` lists. The proposed evolution keeps the same authenticated `server.session.sandbox.context` and `preflight` command family while exposing independent **registered implementation support** and implementation-specific options.

A strategy Tab stays present as an information destination. Within it, **each native policy implementation is an independent, clearly identified panel**. A sample mock catalog with `status = available/unavailable/unknown` drives all panels:

| Policy implementation | Linux full | Linux no cgroup delegation | Linux no seccomp profile | macOS Seatbelt | Offline |
|---|---|---|---|---|---|
| `filesystem.access` | available | available | available | unavailable | unknown |
| `network` | available (all 3 modes) | available | available | available (allow/deny only, restricted disabled) | unknown |
| `process.linux_namespaces` | available (each namespace measured) | available | available | unavailable | unknown |
| `resource.cgroup_v2` | available + native child controller files | unavailable + `controller_not_delegated` | available | unavailable | unknown |
| `syscall.seccomp` | available + registered profile | available | unavailable + `profile_unavailable` | unavailable | unknown |

The existing **仅 Memory/PIDs 委派** fixture demonstrates the second level of discovery: the `resource.cgroup_v2` implementation remains available while only `memory.*` and `pids.*` native control files are exposed. Their Values remain raw Linux strings; the mock does not infer a universally accepted format.

**Rendering rules:** `available` reveals the domain-specific configuration editor; `unavailable` leaves a disabled policy item and the precise source reason; `unknown` disables rather than converting "not probed" to "unsupported". A future `resource.macos_*` policy appears **only once the runtime and versioned schema register a real path**. The client selects that entry's dedicated renderer; an unknown backend path shown by an older client is **client-unsupported and read-only**, never an arbitrary JSON editor. This avoids making the discovery catalog an implicit Schema extension.

The generic sections must also probe the exact implementable guarantee; filesystem access rules are not universally installable, macOS supports `network.deny` but not `network.restricted` in the measured backend, and process Namespace flags cannot be inferred from overall backend availability. `Inside` remains read-only **Agent-authenticated effective** observation, independent of whether catalog support has since changed.

**Policy security:** V1 canonical policy still denies unknown fields. Discovery does not authorize an unsupported value or a new native key; preflight and Enter recheck `context_generation` and `probe_generation`, and explicit unsupported values fail closed with field-level errors. Catalog data must be tied to Agent + Location and not reused between Sessions/Agents without a matching generation. Only real Agent preflight/Enter/backend verification can establish executable support.

### Updated interaction exercises

- Choose **Native / 可进入**, open **Resource**: see `resource.cgroup_v2 · 支持`, native controller candidates and KV editor.
- Choose **cgroup v2 不可用**, reopen Resource: item remains visible, marked `不支持` with `controller_not_delegated` explanation; editor disappears and cannot add a key.
- Choose **seccomp 不可用**, open Syscall: `syscall.seccomp` remains visible but disabled with `profile_unavailable`; Resource remains usable.
- Choose **macOS Seatbelt**: Filesystem access, Linux Namespaces, Resource cgroup v2 and Syscall seccomp are disabled individually; Network still appears, with **restricted** mode disabled while allow/deny remain selectable.
- Choose **Agent 离线**: all implementation rows show `状态未知`, not `不支持`.
- Choose **仅 Memory/PIDs 委派**: Resource strategy available but CPU/IO native files absent; this is not an unavailable Resource implementation.
- Choose **已在 Sandbox**: tabs show read-only observed values and no editable policy item controls.
- Web/App navigation remains one Sandbox route with six peer Tabs; no new route or Back is created by this implementation model.

**Synthetic verification:** The revised update passed **45/45** V8 synthetic-DOM checks against the Tabbed design, native implementation registration and status fixtures. Covers every policy type, cgroup/delegation/profile/macos/offline cases, preflight-on-navigation, and App sizing. This verifies the mock's rendering/fixtures, **not** real browser geometry, Backend, Policy Schema vNext, or a Pages deployment.

## Each policy Tab has its own content, actions and inspection

| Tab | Outside/native configuration | Inside/execution inspection |
|---|---|---|
| Overview | Pane/Agent context, 5 policy summaries, canonical JSON, preflight and explicit Enter | Verified execution identity/scope, 5 summaries, execution detail and Return Native |
| Filesystem | Read-only and Writable host-path lists with independent Add/Edit/Remove; working directory | Actual visible paths or **read-only prepared EROFS** Base Runtime `/`, Project workspace `/workspace`, Toolchain `/opt/rust` |
| Network | `allow`, `deny`, `restricted` mode and conditional allow/deny rule lists | Observed mode and actual allowed/denied targets |
| Process | PID, IPC, USER, UTS, CGROUP namespace toggles; CGROUP requires USER in this mock | Observed installed namespace flags |
| Resource | Agent-discovered cgroup v2 controller file list grouped by native controller, native string KV Add/Edit/Remove, no per-value business parser | Owned cgroup execution file readbacks, requested/applied/unknown status |
| Syscall | Agent registered seccomp Profile select/clear, no arbitrary BPF or syscall-number editor | Installed profile and verified filter evidence |

The UI mirrors native OS semantics without inventing a general policy language. `filesystem.access` and prepared `filesystem.composition` remain different execution inputs; EROFS source paths/digests are never editable here. Resource excludes cgroup lifecycle/hierarchy pseudo-files; Syscall is not a cgroup controller.

## Test walkthrough

1. Select **Native / 可进入**, open Terminal → Workspace → Sandbox. The initial **Overview** shows status, summaries and Enter controls, with **no five inline editors**.
2. On Web click the **left Tabs** (on App the **horizontally swipeable top Tabs**). Visit Filesystem, add/change/remove a RO/RW path. Switch straight to Network, manage allow/deny targets. Switch directly to Process, toggle namespace flags, then to Resource, select `cpu.weight`/`memory.high` and enter a native Value. Choose a Syscall Profile from the registered list.
3. Switch directly to **Overview**, confirm all changes in the canonical JSON, run preflight and explicit Enter. Switching tabs alone should not reset successful preflight; changing any setting does.
4. Inside Sandbox, switch among the same six Tabs. All domain content is now **read-only effective** (mock Agent observation). `Execution details` and `Return Native` remain at Overview. Confirm/Execution details Back returns to the current selection, not a "previous policy" history stack.
5. Choose **EROFS 已组合** → Filesystem tab displays three read-only mount targets; **仅 Memory/PIDs 委派** excludes CPU/IO Resource candidates; macOS disables Linux-only operations; offline leaves status unknown; simulated kernel `EINVAL` refuses Enter.
6. Switch Web 1180/1024 and App 390/375; verify Web left nav + independent right scroller, App horizontal-scroll Tab bar + main vertical scroll, single App Back, input wrapping and no Capsule occlusion. On Web tab-key navigation, arrows and Home/End are supported by the synthetic fixture.
7. Select a Tab after scrolling, switch away and back: the prototype preserves per-tab vertical scroll; on App it attempts to reveal the selected horizontally off-screen Tab (when native DOM is present).

## Ownership, caveats and verification

- Existing WorkspaceShell, CapabilityCapsule, Session/Pane context, current Agent/Location, canonical Policy contract, and host-owned Web/App Back semantics continue to own navigation. Tabs are **capability-local**, not separate global routes and not independent policy records.
- This standalone HTML/JS is synthetic. It does not invoke the Nession Agent, seccomp, actual cgroup v2, EROFS mount, tmux, storage or platform authentication. Inside and cgroup readback are mock fixtures.
- The draft path/rule lists are serialized via simplified comma-joined mock fields; production should retain native typed protocol arrays instead of copying this mock representation.
- Real browser, keyboard/focus and responsive overflow evidence is required by #3143/#3138; synthetic DOM assertions do not prove real Chromium or true kernel enforcement. Pages `manifest.json` SHA and the public HTML deployment are not verified at this revision.
- **Corrected Tab navigation synthetic regression (2026-11-10): 31/31 V8 synthetic-DOM assertions passed** against the current app.js/index.html revision: six tabs with no module depth; independent Filesystem/Network/Process/Resource/Syscall management; one shared Policy; preflight preservation on Tab changes/invalidation on edits; confirm/Enter/Inside readonly; EROFS, macOS, offline; Web left/independent scroll, App horizontal Tab CSS, keyboard Home/End. Source parsed without syntax errors. **Not** real Chromium, accessibility, kernel, server or Pages deployment evidence.
- Historical prototype assertions for other navigation schemes (separate module route or one-inline-editor composition) do **not** validate this current Tab design.

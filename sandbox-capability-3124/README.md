# Sandbox Strategy Tabs — Web/App information architecture (#3143)

**Owning Requirement:** https://github.com/BestNathan/nession/issues/3143  
**Related:** #3124 (Sandbox Pane/Enter/Inspect), #3141 (native cgroup v2 Resource KV), #3137/#3138 (shared visual recipes/design gate), #3024/#3062 (prepared EROFS).  
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

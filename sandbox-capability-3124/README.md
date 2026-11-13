# Prototype · Unified Sandbox Capability (revising #3124 directory)

**Current design owners:**
- [#3408](https://github.com/BestNathan/nession/issues/3408) — Session-scoped Sandbox → Overview / Images / Workspaces / Policies, Web/App IA.
- [#3407](https://github.com/BestNathan/nession/issues/3407) — Agent-owned managed Workspace identity, names, list/reuse, current Project Existing Location.
- [#3405](https://github.com/BestNathan/nession/issues/3405) — Filesystem policy: RootFS, Mounts, Workspace, Home, Access mapping.
- Prior IA [#3143](https://github.com/BestNathan/nession/issues/3143), Sandbox Enter [#3124](https://github.com/BestNathan/nession/issues/3124), native support [#3161](https://github.com/BestNathan/nession/issues/3161), separate Images [#3181](https://github.com/BestNathan/nession/issues/3181) — historical context, **not** the current candidate layout.

**Status:** Updated interactive design candidate on the orphan \`prototype\` branch. **Not a production UI, native Sandbox verification, or Acceptance result**. Publish/readback and Chromium measurements must be recorded separately, not inferred from committing HTML.

**Direct preview (only current after manifest SHA readback):** https://bestnathan.github.io/nession/prototypes/sandbox-capability-3124/index.html

## Scope, entry, ownership and candidate delta

The prototype stays in the **original \`sandbox-capability-3124/\` directory** rather than creating three copies. All three new Requirements are explored by this one coherent Session-scoped Sandbox interaction model.

- Web source ownership: \`WebLayout → Sidebar (flat Sessions) + ShellMain → WorkspacePanel → WorkspaceShell → Sandbox capability-local content\`. Candidate change is **inside Sandbox only**: Header with right aligned Overview/Images/Workspaces/Policies, then per-feature local left sidebar. No new global shell header or global Images/Sandbox entry. A selected Session is always required to reach Sandbox.
- App source ownership: \`AppLayers → WorkspacePanel → one AppPageHeader/Back → WorkspaceShell → Sandbox\`. Candidate capability-local top row switches four sections; nested feature nav is horizontal and scrollable, not a new App route stack.
- Baseline inspected: \`web/src/app/workspace/capabilities.ts\`, \`viewBindings.ts\`, \`web/src/capabilities/sandbox/components/{SandboxWorkspace,SandboxComposer,SandboxPolicyTabs}.tsx\`, \`web/src/capabilities/images/components/ImagesWorkspace.tsx\`, \`docs/design/information-architecture.md\`, \`docs/design/product-model.md\`, \`docs/architecture/sandbox-policy-and-execution.md\`, \`crates/nession-sandbox/src/linux/{bwrap,erofs}.rs\` (main 2026-11-13).
- Current-vs-candidate delta: old prototype's Overview+five peer tabs / independent Images Workspace is superseded by **4 capability sections** and **5 native/portable policy entries** without Process/Resource/Syscall grouping. This is **not** yet implemented on main.
- Visual approximation: local static CSS derived from the prior Nession token-snapshot mock; full Web/App screenshot/component-pixel parity has not been independently proven. Shared outer review frame is \`../prototype-frame-2758/{frame.css,frame.js}\` and is separate from product chrome.

## Interaction paths (fully local mock)

1. Open a selected Session's **Sandbox**; Overview shows Agent/Pane, Server image count, Agent workspaces and quick navigation.
2. **Images → Library / Builds / Distribution**. Choose a Base Runtime or Toolchain and continue to Filesystem. Start/finish a **simulated** build; compare Server Ready with per-Agent \`verified/absent/unknown\` cache. Agent offline does **not** remove Server Images list.
3. **Workspaces → All Workspaces / Detail**. \`sandbox-review\` has Project's Existing Location \`/home/dev/projects/nession\` on current Agent, defaulting \`/workspace\` to that directory. Change Session to \`fix-terminal\` (no Project Location), use **Allocate \`fix-terminal\`** or **Create / Reuse** a named Managed Workspace. Managed resources remain in the mock list after return to Native.
4. **Policies → Filesystem**. RootFS Base EROFS uses implicit target \`/\`; tool EROFS mount uses explicit source digest → \`/opt/rust\` or \`/opt/node\`, read-only; Workspace reference resolves to implicit \`/workspace\` and has separate Agent ownership; \`filesystem.access.read/write\` maps each absolute path \`P→P\` (no arbitrary target). \`/home\` is independently described as ephemeral by current Linux implementation (Session persistent is a candidate only). Current V1 EROFS root/access mutual exclusion is enforced by mock validation.
5. **Policies → Network / Linux Namespace / Cgroup v2 / Seccomp**. Each native policy has its own entry and Agent support status, not generic Process/Resource/Syscall groups. macOS/partial/no-cgroup/no-seccomp fixtures show unavailable without editing or fallback. A draft remains stable when navigating across sections.
6. **Overview → Validate → Enter → Confirm** exercises preflight, a new Pane with read-only effective state, evidence detail and Return Native. Mock Enter stores a snapshot only in browser memory. A real mount/kernel execution does **not** occur.
7. Test **No Session**, Agent offline, macOS, preflight rejection, Enter failure, named Workspace deletion confirmation, Web 1180/1024 and App 390/375. The reviewer-page fixture toggles are external to the product viewport.

## Policy and resource authority — not simulated as real APIs

| Product object | Real source of truth | Mock behavior |
|---|---|---|
| Server Images registry/build/digest | Existing Server-owned Image Manager (#3181) | Synthetic static data + simulated build state |
| Per-Agent image cache/distribution | Agent verified cache, scoped grants (#3023/#3181) | Synthetic verified/absent statuses + "prepare cache" toggle |
| Existing Project Location | Project \`{agent_id,path}\` reference (#3021) | User-owned sample path, always reference-only |
| Managed Workspace | Proposed Agent Workspace Manager (#3407) | In-memory ID/name registry and get-or-create, no filesystem writes |
| Filesystem RootFS/Mount/Access | Proposed client-safe declaration (#3405) and existing internal \`filesystem.composition\` | A source/target mapping preview only, never untrusted host paths |
| Agent policy capability & execution | Current Agent \`SandboxCapabilityCatalog\`, Linux/macOS backend, verified Pane | Synthetic states, no kernel proof, no claims of production readiness |

The mock does **not** establish that arbitrary image mount targets, persistent Home, concurrent RW Workspaces, new wire Policy keys, or mixed EROFS+host-access are implemented or approved. The old \`sandbox-capability-3124/app.js\` legacy six-peer-tab prototype was replaced by the new mock logic rather than forked to a new directory.

## Prototype verification contract

- **Source/static:** \`index.html\` includes exactly one \`data-nession-gallery-link\`, one \`data-nession-source-link\`, a shared review frame and a standalone product view. \`app.js\` parses as JavaScript; no external API/network, credentials or host mutations are performed. All prototype assets use sibling-relative paths.
- **Browser path:** Web 1180 → Images builds/distribution → Workspaces create/reuse → Policies Filesystem → Validate/Confirm → read-only Inside → Return Native. Resize to App 390 and test local section nav and exactly one AppPageHeader/Back; resize back to Web. Test widths 1024/375, stage edge reachability, actual product content CSS width, focus and reset.
- **Negative path:** no selected Session, Agent offline, macOS EROFS unsupported, invalid tool target, EROFS/access conflict, disabled native capability, invalid Workspace name, delete selected Workspace blocked, mount/Enter failure.
- **Status:** Static parse and connector source readback can be recorded when performed. **Actual Chromium/Playwright interaction and screenshot parity, public Pages manifest SHA and production Cases remain pending unless separately observed**. The external reviewer should not treat this mock as a validated production feature.

## Non-goals

No production Web/App changes, schema/codegen edits, global navigation implementation, EROFS builds/downloads, host mounts, Native fallback, new security guarantees, Project CRUD, database writes, real Session creation, or second prototype registry.
# Prototype · Unified Sandbox Capability (revising #3124 directory)

**Current design owners:**
- [#3408](https://github.com/BestNathan/nession/issues/3408) — Session-scoped Sandbox → Overview / Images / Workspaces / Policies, Web/App IA.
- [#3407](https://github.com/BestNathan/nession/issues/3407) — Agent-owned managed Workspace identity, names, list/reuse, current Project Existing Location.
- [#3405](https://github.com/BestNathan/nession/issues/3405) — Filesystem policy IA: RootFS / Mounts / Workspace / Access / Preview.
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

## Builds and Distribution progress contract — #3408 / #3334 (2026-11-13)

**Not the same lifecycle or owner.** Builds is a **Server-owned background job**, while Distribution in this Session context means **this selected Agent's on-demand EROFS Cache preparation for a specific Digest**. There is no implied multi-Agent push/broadcast/distribution service or global fleet completion ratio.

### Builds (real backing implementation exists on staging, not yet on main)

- **Actual staging APIs:** \`server.image.build.submit/get/list/cancel/retry\` and push \`server.image.build.updated\`, with the durable Build directory as truth (see closed #3334 and \`staging:docs/architecture/erofs-image-manager.md\`). On reconnect reread \`get/list\` before using pushes.
- **Actual staging states:** queued/running/succeeded/failed/canceled; stages fetching/snapshotting/validating/packaging/publishing; \`progress.files\`, \`progress.bytes\`, \`progress.elapsed_ms\` as measurable counters, plus bounded diagnostic/error/attempt/digest.
- **No invented total percentage:** \`mkfs.erofs\` does not expose authoritative work completion. The UI can show the current stage, measured source file/byte totals, elapsed time, and an indeterminate activity strip. A completed stage is a fact; a supposed 80% total build bar would be fiction. The full operator \`build.log\` currently stays on Server disk; the public descriptor exposes a bounded last diagnostic, not arbitrary log streaming.
- **Mock sample:** an active Packaging task, a succeeded task, and a failed task (Retry available); submitting makes a queued task, Cancel does not mark bytes ready, and Retry records the next attempt. External reviewer-only \`推进构建阶段\` simulates durable Server push transitions. Production browser tests must bind to real staging descriptors.

### Distribution (Agent EROFS Cache; additional progress protocol needed)

- **Verified current capability:** \`nession_erofs::cache\` persists a digest-addressed \`<sha256>.part\`, downloads using HTTP Range / resume, validates complete SHA-256 and only then publishes a verified blob. Its Agent status API \`ImageCacheStatus {digest,state,detail}\` reports verified/preparing/absent/failed/unavailable but **does not expose per-image transferred/total byte progress**. \`preparing\` can mean a partial file exists from an interrupted transfer and does not establish active downloading. A global completed-fetch byte counter is not the same as live per-digest progress.
- **Candidate minimal observation:** in an Agent-local \`(agent_id,digest)\` context, expose an authoritative snapshot of \`phase\` (absent/resumable/downloading/verifying/verified/failed), \`downloaded_bytes\` (validated partial file size plus newly written bytes), \`total_bytes\` (Server Ready ImageDescriptor.size_bytes or response \`Content-Range\` checked against digest), \`active\`, \`updated_at\`, optional \`error\`. Push updates during download with bounded throttling; after reconnect/restart reobserve Agent verified blob and \`.part\` size. Avoid a new Job DB/queue; retain durable partial file as transfer checkpoint. Do **not** automatically label a surviving \`.part\` as actively downloading.
- **Progress UI:** only for a known total and an active/partial transfer, display \`downloaded/total\` and a determinate bar. When bytes reach total, enter **Verifying** (still not mount-ready); only after SHA-256 match and atomic publication show **Verified**. On cache hit do not transfer bytes. Agent offline shows Unknown; Server Ready does not imply Agent Verified. Show per-Agent readiness, not a fleet-wide percent.
- **Mock sample:** Agent \`nession-dev\` has verified Base/Rust/source, absent Alpine, and a **resumable 12/48 MB Node partial**, not a live ongoing download. Clicking Resume switches to Downloading without claiming immediate success; reviewer-only \`推进下载 / 校验\` increments measured sample bytes, enters Verifying then Verified. Current production lacks the byte snapshot and explicit background Prepare API, so this mock is a **proposed observable UX**, not acceptance or evidence that the transfer can currently be initiated from this view.
- **Security/failure:** Blob grants are consumer/digest scoped and expire; any new manual Prepare/Resume entry must use the existing authorization path and Agent verification. Transfer bytes may not be inferred from unauthenticated Server status or another Agent's cache.

## Image Library list interaction — #3408 (2026-11-13)

- The Library is a list, not a master-detail page. Keep each collapsed row compact: image name, type, shortened digest, Server status and expansion chevron.
- Activating a row expands an inline detail region **immediately below that row**, pushing later rows down. Activating it again collapses; activating another row collapses the former and opens the new one.
- Expanded content: full Digest, image type, current Agent cache observation, default mount (or RootFS target), and only the applicable action. No separate detail panel below the full list and no explanatory paragraphs occupying item layout.
- A row is a native keyboard-focusable button with `aria-expanded`; expanded content is a labelled region. App uses the same tap-to-expand flow and a single-column details layout.
- Image Registry/build/distribution ownership remains unchanged. No real image or Agent operations are performed by the mock.

## Filesystem IA — current owner decision (2026-11-13)

Under **Policies → Filesystem**, render **five always-visible sections in order**, corresponding to what a user actually configures. There is no outer Host Access vs Image Composition switch that hides unrelated inputs, and no extra Home policy editor.

1. **RootFS** (`/`, fixed): source mode `Local` (no image picker) or `Base Runtime EROFS`. The image picker contains **only** `base_runtime` category and **only** digests already verified/loaded in the current Agent cache. Server-Ready alone is not sufficient; unavailable/offline Agent means no cached selection. Read-only RootFS image.
2. **Mounts** (zero or more, **initially empty**): each row selects an immutable **non-`base_runtime` EROFS image**, initially uses its image-defined `default_mount`, and allows an edited destination. Read-only EROFS mount. Selecting an uncached non-base image can be represented in the authoring draft but must show cache state and require Agent preparation before Enter; this is separate from RootFS's stricter selection gate. Multiple rows and removal are supported. `default_mount` image metadata is a **proposed backend/registry field** and requires contract review; the current runtime limits targets to `/opt/<name>`, so wider destinations fail current preflight rather than silently applying.
3. **Workspace** (`/workspace`, fixed **and the default working directory after Enter**): choose current Project's Agent `Project Location` (path is read-only; owned by Project config) or a named Agent-managed Workspace (`Auto` by current Session name, an existing name, or a new manual name). The selected resource is Agent-resolved and mounted at `/workspace`; this editor does not create an independent filesystem registry.
4. **Access** (identity path mapping, independent read and write lists): one absolute Agent path per row, supporting add/remove. `read[]: P→P (RO)`, `write[]: P→P (RW)`; there is no target editor.
5. **Preview** (always visible, never a second policy source): live-derived rows for RootFS /, every Mount destination, Workspace /workspace and all configured RO/RW access paths, including source and effective mode. Text inputs update the Preview without moving input focus.

**Product copy discipline:** headings are ordinary labels; do not place ⓘ or hover explanations on every field. Put short contextual help only on genuinely ambiguous terms, and put architecture rationale, caveats, implementation constraints and mock limitations **outside the product preview** in this README or the review-page annotations. Safety errors, unsupported Agent state, cache readiness and destructive action confirmations remain visible within the product.

**Important protocol distinction:** the committed V1 schema still exposes `filesystem.access` and internal Agent-prepared `filesystem.composition` mutually exclusively. The five-part editor is the **candidate next policy declaration**, not proof of a production wire schema or backend that supports simultaneous Host Access + EROFS RootFS + arbitrary mounts. Existing execution validation explicitly fails unsupported combinations. `Home` is backend-owned runtime state rather than an item in this editor.

## Interaction paths (fully local mock)

1. Open a selected Session's **Sandbox**; Overview shows Agent/Pane, Server image count, Agent workspaces and quick navigation.
2. **Images → Library / Builds / Distribution**. Library is a **plain image list**. A row click expands its detail **directly under that row** (one row expanded at a time; click the same row to collapse); the former detached detail card below the list is removed. The expanded section shows full digest, image type, Agent cache, target/default mount and its relevant action (Use as RootFS / Mount in Filesystem). All detail actions continue to the Filesystem editor. Start/finish a **simulated** build; compare Server Ready with per-Agent `verified/absent/unknown` cache. Agent offline does **not** remove Server Images list. Builds shows actual stage/counters/elapsed, Cancel/Retry; Distribution shows Agent-scoped transferred bytes, paused-resumable partial files, and separate Verifying→Verified states, using external reviewer controls only for synthetic progress transitions.
3. **Workspaces → All Workspaces / Detail**. \`sandbox-review\` has Project's Existing Location \`/home/dev/projects/nession\` on current Agent, defaulting \`/workspace\` to that directory. Change Session to \`fix-terminal\` (no Project Location), use **Allocate \`fix-terminal\`** or **Create / Reuse** a named Managed Workspace. Managed resources remain in the mock list after return to Native.
4. **Policies → Filesystem**. RootFS (`/`) selects Local or only current-Agent-cached Base Runtime EROFS; Mounts starts empty and adds any non-Base EROFS with image default target (editable); Workspace selects read-only Project Location or named managed reference, always mounted at `/workspace` and used as cwd; Access adds independent identity RO/RW paths; Preview continuously lists the resolved mount/source/mode rows. Runtime V1 unsupported combinations fail preflight.
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

The mock does **not** establish that a registry-provided image default mount field, arbitrary image mount targets, concurrent RW Workspaces, the new client policy keys, or mixed EROFS+host-access are implemented or approved. The old \`sandbox-capability-3124/app.js\` legacy six-peer-tab prototype was replaced by the new mock logic rather than forked to a new directory.

## Prototype verification contract

- **Source/static:** \`index.html\` includes exactly one \`data-nession-gallery-link\`, one \`data-nession-source-link\`, a shared review frame and a standalone product view. \`app.js\` parses as JavaScript; no external API/network, credentials or host mutations are performed. All prototype assets use sibling-relative paths.
- **Browser path:** Web 1180 → Images builds/distribution → Workspaces create/reuse → Policies Filesystem → Validate/Confirm → read-only Inside → Return Native. Resize to App 390 and test local section nav and exactly one AppPageHeader/Back; resize back to Web. Test widths 1024/375, stage edge reachability, actual product content CSS width, focus and reset.
- **Negative path:** no selected Session, Agent offline, macOS EROFS unsupported, invalid tool target, EROFS/access conflict, disabled native capability, invalid Workspace name, delete selected Workspace blocked, mount/Enter failure.
- **Status:** Static parse and connector source readback can be recorded when performed. **Actual Chromium/Playwright interaction and screenshot parity, public Pages manifest SHA and production Cases remain pending unless separately observed**. The external reviewer should not treat this mock as a validated production feature.

## Non-goals

No production Web/App changes, schema/codegen edits, global navigation implementation, EROFS builds/downloads, host mounts, Native fallback, new security guarantees, Project CRUD, database writes, real Session creation, or second prototype registry.
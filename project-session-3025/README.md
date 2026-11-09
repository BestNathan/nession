# Project / EROFS / Session creation — interactive prototype

**Owner:** https://github.com/BestNathan/nession/issues/3025

**Linked requirements:** https://github.com/BestNathan/nession/issues/3021 (Project); https://github.com/BestNathan/nession/issues/3022 (Global EROFS); https://github.com/BestNathan/nession/issues/3023 (Agent PVC cache); https://github.com/BestNathan/nession/issues/3024 (Sandbox mount); https://github.com/BestNathan/nession/issues/2681 (Sandbox base).

## Product baseline

Main source inspected 2026-11-08: WebLayout → Sidebar (Agents + flat Sessions) + ShellMain → WorkspacePanel → WorkspaceShell → Project capability. AppLayout/AppLayers: Sessions ← Terminal → Workspace; WorkspacePanel owns the single AppPageHeader and Back, while WorkspaceShell owns the capability capsule. Reference sources: web/src/app/experiences/web/WebLayout.tsx, web/src/app/experiences/app/AppLayout.tsx, web/src/app/experiences/app/AppLayers.tsx, web/src/app/Sidebar.tsx, web/src/app/WorkspacePanel.tsx, web/src/app/workspace/WorkspaceShell.tsx; FixtureShell / FixtureApp; docs/design/product-model.md, workspace.md, interaction/web.md, interaction/app.md; design/generated/web.css.

**Decision revision:** Project is a first-class navigation entry in Web Sidebar and App Sessions layer, with an independent Project detail destination that works even without a selected Session. The detail may share styling and reusable capability components with Workspace, but it must not depend on WorkspaceShell's Session context. Existing and Managed remain two Session create paths, not Project types. Do not add persistent ProjectEnvironment.

## Questions

Can a Project's existing Agent directory and reusable global EROFS artifacts be used from one contextual creation flow without forcing Agent ownership? Can a managed image preparation failure preserve user input and fail closed before Sandbox launch? Can App navigate through the same work with exactly one Back/header at each depth?

## Interactive paths

1. Web Sidebar → Projects → Nession, or App Sessions → Projects → Nession → independent Project detail. Inspect Git source/ref, MacBook location, shared Base/Node/Rust/Source EROFS references; edit settings and return. Current Session is preserved.
2. Create Existing Session → MacBook path → name → explicit Create → mock Terminal. No image or sandbox.
3. Terminal → Project → Create Managed → select Linux Agent, Source Digest, optional Node/Rust images → prepare images → explicit Create → Terminal.
4. External fixture choices: Agent offline, download failure, unsupported sandbox, warm Agent cache; verify errors, retained draft, retry and no Native fallback.
5. Mock build changes EROFS source artifact to a new immutable digest; existing Session stays on its old version.
6. Switch Web 1180/1024 to App 390/375 and back; verify Project navigation selection, Web rail one Expand plus passive counts, App Sessions → Project detail → Back → Sessions. Use external No Session fixture to test independent Project navigation then create first Session.

## UI Spec / ownership

Web candidate: 246px sidebar hosts Agents, flat Sessions, and a small **Projects** section that remains reachable regardless of Session scroll; clicking a Project renders **ProjectDetail as a distinct main-region destination**. No forced Session-to-Project nesting. Collapse keeps only Expand actionable; Agent/Session/Project counts are passive. App candidate: Sessions spatial layer includes Projects below Session history and above Agents; clicking pushes Project detail with one 55px host-owned AppPageHeader/Back, returning to Sessions. No Project detail is mounted under the Session-scoped WorkspacePanel. Terminal remains separate and mounted by the product shell during navigation. CSS widths 1180/1024 and 390/375. Scoped local semantic token snapshot based on Nession's generated CSS. This is a high-intent UX study, *not* confirmed pixel-identical to Nession shipped React UI.

## Fidelity and verification

Deterministic, in-browser state only: all Project, Agent, EROFS, Download, Sandbox, Session and settings actions are simulated. No actual GitHub/Server requests, no secrets, no real tmux, no EROFS bytes, no PVC or mount operations. Prior Nession diagnostic Task measurements of 23.90 MiB Project Source, 57.99 MiB Node and 246.47 MiB Rust are displayed as static evidence-backed examples, not runtime results for this mock.

- Static JS syntax was checked at authoring; relative references use local styles.css/app.js and the shared prototype-frame-2758 frame files.
- **Publication for this interaction revision:** public Pages manifest/source HTML readback matched source `a0cab3b6fa161a85bc83e4f331754d1c8acbba2b` in the trusted deployment [Run 42499871771](https://github.com/BestNathan/nession/actions/runs/42499871771).
- **Real Chromium verification for this interaction revision:** [Task 42499995613](https://github.com/BestNathan/nession/actions/runs/42499995613), [archived task-results record](https://github.com/BestNathan/nession/blob/task-results/runs/prototype-project-sidebar-3025-20261109/42499995613-1/record.json): 30/30 browser assertions passed; Web 1180/1024, App 390/375, Sidebar project selection, standalone Detail, settings, Existing/Managed create, fail/retry, App Back, no Session create, collapsed rail, no page errors.
- **Remaining:** real React Fixture side-by-side/pixel comparison, keyboard/focus accessibility audit beyond tested mouse paths, and production implementation/Acceptance are not proven by this mock. This README documents evidence captured for the immediately preceding, behavior-identical HTML/CSS/JS source. For any new source commit, check publisher manifest SHA before calling live content current.
- This prototype is not production Acceptance evidence.

Direct HTML: https://bestnathan.github.io/nession/prototypes/project-session-3025/index.html
Source: https://github.com/BestNathan/nession/tree/prototype/project-session-3025

## Non-goals

No extra EROFS Manager top-level dashboard, automatic scheduler, real session creation, OCI layers, private Github auth, sandbox privileged host test, real browser production parity, or ProjectEnvironment object.

## Project maintenance decision

Projects in the Web Sidebar and App Sessions are direct maintenance entry points: + creates a name-only Project, rows select the standalone detail, ··· opens Rename/Settings or Delete (confirmation required). Detail settings control name, optional GitHub Source/ref and Existing Agent directory. Project deletion does not destroy Sessions, owned directories or globally shared EROFS. Multi-project mock state is not Server persistence. Browser tests and public SHA must be renewed for this revision.

## Session Project capability / association (2026-11-09, #3082)

- Project relation is an **explicit optional Session.project_id** managed by Server, not inferred from Agent, cwd, Git or the Project selected in the Sidebar. A Project may have multiple Sessions; a Session belongs to zero or one. Project and Workspace IDs stay separate.
- A focused Session with a Project exposes a compact Terminal Capsule Project hint (relevant state) and a Peek with current Project ID, name, Source/ref and actions; the Workspace Project capability (active only when opened) shows Source, Locations, EROFS, related Sessions and links to Project Settings or standalone ProjectDetail. Return preserves the exact focused Session.
- No Project: small discoverable `+ Project` association action. Explicit Assign, Change and Remove act on Session metadata only, never cwd, env, mount or actual process; deleting Project clears its mock links without killing Sessions. The mock inspector reports `available/relevant/active` per focus.
- Switch Session A/B after creating a second Project, and compare Peek; unbind one and ensure no stale Project. Same flows should work at App 390/375 with one host-owned Back/Header.
- This mock does not implement Server persistence, authorization, Session reincarnation protection, Agent metadata, or production Capability Registry wiring. Browser and published Pages evidence must be freshly collected for this new SHA.

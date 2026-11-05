# Workspace + Capability Fidelity

Read when a mock displays Workspace, Files, Git, Environment, Claude Code, Agent context, or a capability's deeper surface. Pair with [presentation frame](presentation-frame.md) and [Web/App shell](web-app-shell.md) when relevant.

## Reference sources

- Product: [Workspace semantics](../../../../docs/design/workspace.md), [capability emergence](../../../../docs/design/capability-emergence.md), [Web interaction](../../../../docs/design/interaction/web.md), [App interaction](../../../../docs/design/interaction/app.md).
- Patterns: [WorkspaceNavigation](../../../../docs/design/design-system/patterns/workspace-navigation.md), [FileWorkspace](../../../../docs/design/design-system/patterns/file-workspace.md), [design-system tokens](../../../../docs/design/design-system/tokens.md).
- Real rendering: [WorkspaceShell](../../../../web/src/app/workspace/WorkspaceShell.tsx), [WorkspacePanel](../../../../web/src/app/WorkspacePanel.tsx), [CapabilityCapsule](../../../../web/src/app/workspace/CapabilityCapsule.tsx), [FilesWebLayout](../../../../web/src/app/experiences/web/FilesWebLayout.tsx), [FilesAppLayout](../../../../web/src/app/experiences/app/FilesAppLayout.tsx), [generated CSS](../../../../design/generated/web.css).
- Reference fixture: [FixtureWorkspace](../../../../web/src/app/fixture/FixtureWorkspace.tsx), with deterministic capability data.

## Visual and semantic rules

Workspace is **contextual depth around the user's work**, not a permanent landing dashboard or a second global application shell. Nession owns host composition, navigation and visual language; each capability owns its internal content. A logical Workspace can span multiple resource Locations; a Session/Agent default is not necessarily the global resource root.

- **Web:** current explicitly opened capability can fill the main region. Files may use its own tree + viewer/editor master/detail, but this is **Files-local**, not an all-capability layout. Avoid ornamental cards, extra universal sidebars and gratuitous toolbars.
- **App:** use Workspace layer/depth and pushed detail or App-specific sheets rather than miniaturizing Web's split Files browser. Respect back/gesture/safe-area behavior.
- Show capabilities only when useful/available/relevant; do not add permanent tabs for every registered tool. Keep source/location details quiet until ambiguity or failure makes them useful.
- Product-native empty/unavailable/error/confirmation feedback belongs **inside** the UI. Debug events, mock failure selectors, requirement explanations, and test notes are **outside** in the prototype harness.
- Keep return-to-Session, selection and appropriate scroll/dirty state consistent. Do not conflate unavailable FileSource, detached client, exited Session and offline Agent.

## Visual comparison checklist

Compare against current Workspace fixture and product code for background/surface treatment, typography, controls, selection, navigation depth, Web/App differences and spacing. Exercise a complete capability interaction plus empty/error states. If the Issue proposes a different Workspace model, record what differs from the baseline in README and mark it as a *candidate* design externally.

# Timer Workspace — clickable IA + state prototype (#3810)

**Owning Requirement:** https://github.com/BestNathan/nession/issues/3810  
**Backend owners:** #3807 Server definition/placement; #3808 Scheduler Providers; #3809 Action Consumer/Run.  
**Status:** Design candidate / mock only. No implementation, real Agent connection, privileged OS timer installation, acceptance verdict or Pages publication claimed.

## Product / fidelity baseline

- Source-aligned design references: main \`VISION.md\`, \`PRINCIPLE.md\`, \`docs/design/product-model.md\`, \`docs/design/visual-language.md\`; \`design/generated/web.css\`, \`docs/design/design-system/patterns/{resource-detail,configuration-form,operation-surface}.md\`.
- Main Web shell owner: \`WebLayout → Sidebar + ShellMain → WorkspacePanel → WorkspaceShell → Timer capability\`. Sidebar includes Agents/flat Sessions/Projects, not a Timers-only main app. Capability controls are inside WorkspaceShell.
- Main App semantic owner: \`AppLayout/AppLayers → WorkspacePanel → one AppPageHeader per depth → WorkspaceShell → Timer capability\`. App presents full-page operation, not a nested Web dialog; one Back only. A future Session-less Timer resource route is **candidate IA** and not claimed to be shipped.
- Uses shared prototype review frame \`../prototype-frame-2758/frame.{css,js}\` (review UI outside product), CSS local snapshots of Nession role palette and spacing. **1:1 CSS width is not proof of pixel-identical rendering**. No Web source or generated design tokens are modified.

## Interaction questions

1. Can Server desired Definition and Agent observed Binding be seen distinctly without exposing backend implementation by default?
2. Can a user choose fixed Agent vs Project Location affinity without mistaking an offline Agent for successful installation?
3. Does a list open an actual details depth rather than stacking details below the list?
4. Can users create, edit, pause, inspect runs and delete safely with Web Dialog vs App full-page operation while preserving Workspace context?
5. Does an Agent detail present assigned realizations and Provider facts, not claim ownership of Timer definition?

## Walkthrough / representative states

- Enter Timers from selected Session Workspace context; default has four mock tasks: Ready, Pending (offline macbook), Paused, Blocked (stale target).
- Filter/search; open any row; inspect Definition, Assignment, Provider and optional deployment diagnostics; open Runs tab.
- Create New Timer, choose Daily/Hourly/Once, action \`claude.submit\`, \`shell.execute\`, or \`project.create_session\`; configure fixed Agent or Project Location affinity. Choose macbook-offline → Create → Server saved / Pending. Simulate macbook online using **external review control** → Ready observation.
- Validation: blank Name, malformed HH:MM and incompatible Project Location fail and preserve draft; no auto Agent switch.
- Run now is only enabled when Ready; creates a local mock Run row. Pause/Resume increments desired revision; Delete requires explicit confirmation and removes mock definition. Agent detail scopes assigned Timers and user-scope systemd provider.
- Switch Web 1180 ↔ App 390 ↔ Web 1024 and use navigation/actions again. Review Reset restores seed.
- Empty list via external review control; search no-result copy differs from true absence.

## What is real / mock

- **Mock only**: seed Timer/Agent/Project/Session state, local in-browser memory updates, pretend Server commits/epoch/revision and local Run records.
- **Not real**: Server API calls; systemd or launchd probes and timers; authorization; Agent connection/offline leases; true Cron/timezone calculation; project-location lookup; Session lifecycle; actual task execution; persistence across page reload; production Nession routing.
- UI is a *source-aligned approximation* of current color/material/typography and ownership. Pixel comparison against real fixtures, actual Chromium/mobile click-through and public Pages manifest readback are **not yet verified**.

## Static smoke / manual review

Files: \`index.html\`, \`styles.css\`, \`app.js\`; relative external shared frame assets on the same orphan branch. No external CDN/network.
Open in browser (or via static local server). Validate Web 1180/1024 and App 390/375; on a browser narrower than the Web device, horizontal-scroll the review stage to both edges. Verify create→offline Pending→online Ready→run→pause→delete, invalid input, Agent projection, Back and Web/App roundtrip. No mock click result qualifies as production Success Criteria proof.

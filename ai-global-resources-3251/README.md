# AI · Current Session Agent Skills & MCP — Requirement #3251

- **Owner:** https://github.com/BestNathan/nession/issues/3251
- **Direct page (when published):** https://bestnathan.github.io/nession/prototypes/ai-global-resources-3251/index.html
- **Source:** branch `prototype`, directory `ai-global-resources-3251/`; immutable SHA provided by branch commit.
- **Prototype decision:** required (one current Session Agent; project resources are still owned by AI client extensions).
- **Fidelity:** entirely synthetic fixture, native HTML/CSS/JS, no API calls, credentials, real disk writes, runtime downloads, or MCP server execution.

## Ownership / baseline

Current main source checked: `web/src/app/experiences/web/WebLayout.tsx`, `app/Sidebar.tsx`, `app/WorkspacePanel.tsx`, `app/workspace/WorkspaceShell.tsx`, `app/workspace/capabilities.ts`, `app/workspace/viewBindings.ts`, `app/experiences/app/AppLayers.tsx`, `app/patterns/AppPageHeader.tsx`, `docs/design/workspace.md`, `docs/design/information-architecture.md`, `design/generated/web.css`.

**Web IA:** WebLayout → Sidebar (Agents + Sessions) and ShellMain → WorkspacePanel → WorkspaceShell (AI selected, dock and Terminal return) → AI current Session Agent list/detail. **App IA:** AppLayers → WorkspacePanel/AppPageHeader (exactly one header/Back) → WorkspaceShell → AI list or pushed detail. No Agent selector, cross-node inventory, Project selector, effective-config merger or second Back action. Browser fidelity/production pixel parity not yet checked; this is a source-grounded simplified mock, not a production replica.

## Test scenarios

1. **Desktop 1180/1024:** AI capability shown inside Session-first Web Shell, switch Skills/MCP, search, inspect provenance and actions; changing the existing Web Session selection changes its Agent and list automatically.
2. **App 390/375:** single app-level back; select global item -> pushed detail; Back returns list; Back from AI root returns Terminal; AI bottom dock persists across pushed depth.
3. **Current Session Agent vs project:** AI never scans projects; distinct `Shared` / `Claude Code` / `Codex` user-level locations; extension-specific project scopes are excluded.
4. **Operations:** explicit install Skill with Git URI and full SHA or add MCP HTTP/stdio; validation and duplicate detection, cancel, local-only result; managed update/remove confirmation. External/unmanaged entry is visible but cannot be removed.
5. **Negative:** use a current Session whose Agent is offline, empty, or missing (fixture control outside product); do not merge offline/unsupported with an empty live inventory. MCP is configured/not probed and does not claim client-loaded status.
6. **Accessibility:** keyboard tab through controls, Escape closes modal or App detail; App touch-sized buttons, independent scroll and focus retention.

## Revision 2026-11-11 · current Session context

The AI capability now **derives its Agent exclusively from the active Session** and has **no Agent selector**. It does not aggregate other nodes. Web Sidebar Session changes are the only in-product Agent-context change in this mock. The external review fixture changes Session for App/offline/no Session cases; it is not a product control. Pending simulated mutations are abandoned when Session context changes. Same-Agent Sessions share inventory; another Agent has a separate inventory; no Session or offline Agent must not be rendered as a successful empty list. Project Skills/MCP remain client-extension-owned.

**Evidence:** Source/IA review and syntactic/static checks planned for this revision; actual Chromium and production pixel match require independent browser execution.

## Review frame

Uses sibling `../prototype-frame-2758/frame.css` and `frame.js`, with the required `data-np-root`, `np-device`, Web 1180/1024, App 390/375, Reset and source/gallery links. Design tokens are a small snapshot of generated CSS declarations; viewport size is real CSS pixels, no scaling. Internal mode is driven by bubbling `np:resize`.

### Verification record (at initial authoring)

- Source-based IA mapping: **reviewed**; actual Chromium/Playwright click-through, CSS geometry measurement, visual comparison to production fixture, Pages manifest publish SHA and live integrations: **unverified**.
- Deterministic interaction script exists in the HTML and is intended for manual/browser review; it is **not** a trusted production Acceptance test.
- All displayed resource names/paths are invented fixtures, not taken from private hosts.

## Limitations / implementation non-goals

This is not a code implementation: actual OS-user identity, Git download, atomic Skill file mutation, MCP client adapter config preservation and true server/tool reachability need independent PR-level tests in Issue #3251. The `mock` only models relevant user actions and state. Native npm-free manager is an implementation design choice, not a claim that installed Skills/MCP servers are npm-free.

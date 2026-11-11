# AI · Global Skills & MCP — Requirement #3251

- **Owner:** https://github.com/BestNathan/nession/issues/3251
- **Direct page (when published):** https://bestnathan.github.io/nession/prototypes/ai-global-resources-3251/index.html
- **Source:** branch `prototype`, directory `ai-global-resources-3251/`; immutable SHA provided by branch commit.
- **Prototype decision:** required (new AI capability; distinct global vs project ownership; Web/App details/operation states).
- **Fidelity:** entirely synthetic fixture, native HTML/CSS/JS, no API calls, credentials, real disk writes, runtime downloads, or MCP server execution.

## Ownership / baseline

Current main source checked: `web/src/app/experiences/web/WebLayout.tsx`, `app/Sidebar.tsx`, `app/WorkspacePanel.tsx`, `app/workspace/WorkspaceShell.tsx`, `app/workspace/capabilities.ts`, `app/workspace/viewBindings.ts`, `app/experiences/app/AppLayers.tsx`, `app/patterns/AppPageHeader.tsx`, `docs/design/workspace.md`, `docs/design/information-architecture.md`, `design/generated/web.css`.

**Web IA:** WebLayout → Sidebar (Agents + Sessions) and ShellMain → WorkspacePanel → WorkspaceShell (AI selected, dock and Terminal return) → AI global list/detail. **App IA:** AppLayers → WorkspacePanel/AppPageHeader (exactly one header/Back) → WorkspaceShell → AI list or pushed detail. No global AI navigation tree, Project selector, client-effective merger or second back action. Browser fidelity/production pixel parity not yet checked; this is a source-grounded simplified mock, not a production replica.

## Test scenarios

1. **Desktop 1180/1024:** AI capability shown inside Session-first Web Shell, select Skills/MCP, target selector, search, click list to view provenance and management actions; dock returns to Terminal and back.
2. **App 390/375:** single app-level back; select global item -> pushed detail; Back returns list; Back from AI root returns Terminal; AI bottom dock persists across pushed depth.
3. **Global vs project:** intentionally no project-level resources in AI; distinct `Shared` / `Claude Code` / `Codex` user-level locations; extension-specific project scopes are excluded.
4. **Operations:** explicit install Skill with Git URI and full SHA or add MCP HTTP/stdio; validation and duplicate detection, cancel, local-only result; managed update/remove confirmation. External/unmanaged entry is visible but cannot be removed.
5. **Negative:** switch target to offline or empty (or use fixture control outside product); do not merge offline/unsupported with an empty live inventory. MCP is configured/not probed and does not claim client-loaded status.
6. **Accessibility:** keyboard tab through controls, Escape closes modal or App detail; App touch-sized buttons, independent scroll and focus retention.

## Review frame

Uses sibling `../prototype-frame-2758/frame.css` and `frame.js`, with the required `data-np-root`, `np-device`, Web 1180/1024, App 390/375, Reset and source/gallery links. Design tokens are a small snapshot of generated CSS declarations; viewport size is real CSS pixels, no scaling. Internal mode is driven by bubbling `np:resize`.

### Verification record (at initial authoring)

- Source-based IA mapping: **reviewed**; actual Chromium/Playwright click-through, CSS geometry measurement, visual comparison to production fixture, Pages manifest publish SHA and live integrations: **unverified**.
- Deterministic interaction script exists in the HTML and is intended for manual/browser review; it is **not** a trusted production Acceptance test.
- All displayed resource names/paths are invented fixtures, not taken from private hosts.

## Limitations / implementation non-goals

This is not a code implementation: actual OS-user identity, Git download, atomic Skill file mutation, MCP client adapter config preservation and true server/tool reachability need independent PR-level tests in Issue #3251. The `mock` only models relevant user actions and state. Native npm-free manager is an implementation design choice, not a claim that installed Skills/MCP servers are npm-free.

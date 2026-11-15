# Claude Code MCP management prototype — Issue #3600

Owner: https://github.com/BestNathan/nession/issues/3600
Related: #3251 (non-project/user-level AI global resources), #3264 (Nession MCP Server), #105 (historical Claude config reader), #2689 (Claude Memory reader).
Entry: index.html

## Scenario and question

From the current Session, enter the existing Claude Code Workspace, switch from Conversations to MCP, inspect a configured server, discover Tools with an explicit action, add/edit/remove a local or project configuration, and configure Nession MCP through an authenticated preflight/confirmation. Verify that offline Agent, disabled endpoint, unprovisioned credential and conflicting name fail closed. No new global Agent selector or Workspace shell.

## Product ownership and fidelity

- Web: WebLayout → Sidebar (Agents + Sessions) + ShellMain → WorkspacePanel → WorkspaceShell → Claude Code → MCP list/detail. Web Sidebar owns Session switch.
- App: AppLayers → WorkspacePanel / one AppPageHeader Back/title → WorkspaceShell → Claude Code → MCP list/detail. External reviewer fixture simulates Session switch; no desktop Sidebar.
- Main source: web/src/capabilities/claude-code/{ClaudeCodePlugin.ts,contribution.tsx,components/ClaudeCodeWorkspace.tsx}; crates/nession-claude-code; docs/architecture/mcp.md; docs/design/workspace.md.
- Candidate delta: add an MCP resource view to current Claude Code Conversations / Transcripts / Memory / Configuration. Global/user config remains the responsibility of #3251; this mock represents it as read-only in Claude.
- Visual snapshot: relevant semantic color, surface, type and spacing approximations from design/generated/web.css and shared prototype-frame-2758. DOM ownership is modeled from current source; no real browser/production fixture pixel comparison has yet established fidelity.

## Interactive review path

1. Default is Conversations; click MCP.
2. Choose github (stdio) or internal-docs (HTTP). Click Inspect tools; stdio requires a second confirmation. Expand Tool input schema. No tool invocation.
3. Add Server with Local/Project scope, HTTP/SSE/stdio, name and URL/command. Save, edit, remove. User/global editing is delegated to #3251; invalid URLs, empty input and duplicate names are rejected.
4. Click Connect Nession MCP, pick Server/Agent/Standalone host and Local/Project scope. Review endpoint/auth state, confirm, then optionally inspect its four fixture Tools.
5. Switch external fixture to disabled/credential/offline/conflict and retry; these block auto configuration. Click Session row in Web or external Switch Session in App to clear modal, selection and old Agent data.
6. Test size controls Web 1180 / 1024 and App 390 / 375; App Back closes dialog, then details, then returns to Terminal. Reset refreshes the mock.

## Mock safety and limitations

- All data and effects are browser-only in-memory mock. example.invalid endpoints, synthetic Sessions, no real credential/token, no external network, no CLI, no file mutations, no OAuth, no stdio process, no tools/call.
- Configured is distinct from probed reachable and live Claude-loaded. Even a successful simulated probe never claims loaded.
- The four Nession Tool names represent a current documented fixture; production must dynamically discover the endpoint catalog rather than hard-code it.
- Nession MCP may be disabled by default, requires endpoint-owned Bearer authentication and must never be enabled as a side effect of Claude client setup.
- Browser/playwright click-through, exact 1180/1024/390/375px measurements, horizontal stage scrolling, real production pixel comparison, trusted Pages manifest SHA/HTTPS readback and Acceptance: **Pending**.
- This is not production implementation or evidence of any Requirement Success Criteria.

## Publication

Prototype lives only on the history-isolated shared prototype branch, not main or staging. The direct Pages URL (https://bestnathan.github.io/nession/prototypes/claude-mcp-3600/index.html) must be treated as UNVERIFIED until HTTPS and manifest SHA confirm the exact commit. The publisher replaces View source with an immutable commit URL.

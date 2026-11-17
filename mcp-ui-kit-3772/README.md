# Shared MCP UI Kit — interactive prototype (#3772)

- **Owner Requirement:** https://github.com/BestNathan/nession/issues/3772
- **Consumers:** #3251 current-Session Agent global/user-level AI resources; #3600 Claude Code local/project MCP management, capability discovery and Nession onboarding.
- **Related contracts:** #565 / #3264 nession-mcp hosting/protocol, #3735 mandatory Nession-owned outputSchema.
- **Entry:** [index.html](index.html), linked from the shared `prototype` branch root gallery.

## Scenario / question

Can a **single reusable MCP component kit** express configuration management, connection status, complete Tool Input/Output contracts and explicit, bounded invocation across distinct ownership contexts, without inventing a new Nession feature shell or global Agent navigation?

## Product surface and fidelity

- **Web:** `WebLayout → Sidebar (Agents + Sessions) + ShellMain → WorkspacePanel → WorkspaceShell → one capability → MCP kit`. The left Session list is the existing global shell, and the two list columns inside MCP are **capability-local** Server/Tool navigation, not global Workspace nav.
- **App:** `AppLayout/AppLayers → WorkspacePanel → one AppPageHeader → WorkspaceShell → capability content`. The App Back belongs to the host; the mock reproduces depth `Server list → Tool list → Inspector → Runner → Terminal` without a second in-content Back/header. Web/App share semantic components but differ in composition.
- **AI #3251 context:** currently selected Session Agent, **non-project** native config only. No independent Agent selector or cross-Agent aggregation; current Session is the only target. Project entries are hidden here.
- **Claude #3600 context:** Claude extension owns Local and Project scope; user/global management stays with #3251. The host selector is **outside the product viewport** (review fixture) and never represents a new Workspace-level Agent switcher.
- **Visual baseline:** CSS geometry/palette is adapted from the live `claude-mcp-3600` prototype, which is a source-aligned approximation of `design/generated/web.css`. This mock uses the shared `prototype-frame-2758` review harness, 1180/1024 Web and 390/375 App 1:1 CSS viewports. Real current production pixel parity is **not** established.
- **Shared recipes consumed by the implementation:** ResourceDetail, ConfigurationForm, OperationSurface; UI kit should not publish a second token or overlay system.

## Representative fixture / interaction paths

1. Open Web 1180, select `nession`. Inspect `session.list` readable property fields and full Raw JSON input/output schema. Output Schema is **contract**, not runtime output.
2. Enter Tool Runner, edit scope/limit through form or JSON mode, run explicitly, switch Result between **Structured / Content / Raw**, inspect call history. No tool executes merely by selection.
3. Select `session.rename`, populate its title, press Run: a separate confirmation appears for potential mutation; Cancel preserves the draft. Confirm yields synthetic result only.
4. Select `github` (stdio): configured and independently probed are distinct. Explicit Test gives a consent reminder before synthetic connection; then its external `search_repositories` Tool displays **Output Schema not advertised** while preserving raw results.
5. Select Config: add/edit/remove definition using adapter-allowed scope. AI only allows user, Claude allows local/project. Invalid URL and name collision do not mutate state; removal requires confirmation.
6. Select Connection: distinguish configured, independently probed/reachable, negotiated protocol, credential binding, and loaded-in-client unknown. External fixture Offline and Missing Credential block run/test; Error fixture produces isError.
7. Switch Web 1180 → App 390 → Web 1024 without refreshing. In App navigate Server list → Tools → Inspector → Runner and back with **host-owned AppPageHeader**. Switch Session through outside control (App) or shell Session list (Web), which clears stale draft/result and reports offline separately from empty.
8. Reset should restore the initial known `AI` fixture and initial viewport. External fixture state is intentionally outside the Nession product UI.

## Mock versus real behavior

| Concern | Fidelity | Boundary |
| --- | --- | --- |
| Session/Agent selection | mock | Web Sidebar and external App fixture simulate Session context; no remote Agent targeting |
| Server inventory/config | mock | In-memory only; no Claude/Nession filesystem writes or external processes |
| Transport, discovery, connection | mock | No network or stdio. Test/Disconnect only change synthetic state. `loaded in client` never inferred |
| Tool Input/Output schema | recorded-style **synthetic fixtures** | Examples are **not** a claim of actual currently-advertised Nession Tool names or schemas; production always discovers `tools/list` dynamically |
| Tool call and result | mock | Explicit local `tools/call` simulation, synthetic structuredContent/content/isError/raw; no external invocation |
| Secrets | mock | Credential references/status only; never include real or test bearer secrets |
| Error, offline, no schema | mock | Deliberate negative cases and fallback Raw JSON for unknown Tool/response fields |
| Persistence | mock | Page in-memory only, reset/reload discards state |
| Public Pages | unverified until manifest & HTTPS readback | A GitHub source file/branch push is **not** proof the Pages URL is current |

## Architecture contract for the future TypeScript package

```text
web/src/capabilities/mcp-ui/   (candidate owner; implementation placement to settle)
  components/
    McpServerList, McpServerEditor, McpConnectionPanel,
    McpToolList, McpToolInspector, McpSchemaViewer,
    McpArgumentsEditor, McpToolRunner, McpToolResult, McpCallHistory
  types.ts                      (typed adapter contracts, not transport)
```

A reusable kit may have an owner under `capabilities/` but cannot import AI/Claude domain internals or `WebSocketService` directly. Consumers supply `McpProvider` methods (inventory, optional config mutations, diagnostics, explicit discover, optional invoke) and authoritative `session_id/agent_id` context. Provider implementations own transport, process permissions, auth, result bounds, cancellation, audit and persistence. View opens must not trigger `tools/call` or arbitrary stdio launch.

For real `McpToolResult`, preserve **`structuredContent`**, ordered **`content`** items (text/image/resource and unknown), **`isError`**, and full raw envelope. `inputSchema` is always shown; `outputSchema` is required for Nession-owned Tools (#3735), optional/unknown for external. Render invalid/missing schemas honestly; do not invent them.

## Acceptance checks and publication

- Review widths: Web **1180, 1024**, App **390, 375** CSS pixels, no transform scale. Test narrow reviewer browser 960 vs Web 1180 and horizontal stage edges.
- Critical flows: add/edit/remove and cancel, stdio consent, offline/credential gating, schema Raw, form/JSON validation, write confirmation, isError and unknown schema, Session switch invalidation, App Back.
- Accessibility: role/labels, focus/keyboard, one scroll owner in each view, no duplicate App Back, form state retained on failed validation.
- **Pending** at time of source authoring: actual Chromium/Playwright click-through, measured viewport and scroll evidence, current source fixture pixel diff, Pages manifest exact-SHA and HTTPS readback, trusted Acceptance SC proof.
- **Branch:** history-isolated shared `prototype`, directory `mcp-ui-kit-3772/`. No new prototype branch and no production files in this change.
- **Source:** https://github.com/BestNathan/nession/tree/prototype/mcp-ui-kit-3772
- **Potential public preview:** https://bestnathan.github.io/nession/prototypes/mcp-ui-kit-3772/index.html (**not verified current**).

Keep this README and the owning Issue's pinned source updated whenever the design changes. Never use prototype results as production runtime proof.

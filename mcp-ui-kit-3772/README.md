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
- **Visual baseline (revised 2026-11-17 after review):** The product preview now uses an explicit snapshot of the **canonical values and roles** in `design/generated/web.css` (semantic background/surface/navigation, foreground/muted, border, radius, control height, Web/App title/body/metadata/code typography). It follows the **ResourceDetail** identity/fact/section grammar, **ConfigurationForm** field/validation rhythm, and **OperationSurface** action/dismissal. The review page still uses shared `prototype-frame-2758`; 1180/1024 Web and 390/375 App stay at 1:1 CSS widths. This is a source-aligned **mock implementation of the recipes**, not a claim of actual React recipe reuse or current production pixel parity.
- **Shared recipes consumed by the implementation:** ResourceDetail, ConfigurationForm, OperationSurface; UI kit should not publish a second token or overlay system.

## Representative fixture / interaction paths

1. Open Web 1180, select `nession` → `session.list`. The **Contract** view shows tool identity, description, **Input Schema** and **Output Schema** as simple readable parameter/type/description rows, with separately expandable raw JSON. Output Schema is **contract**, not runtime output.
2. Open the **Run** depth (not stacked under the default Inspector). Edit scope/limit through form or JSON mode; run explicitly, switch Result between **Structured / Content / Raw**, inspect call history. No tool executes merely by selection.
3. Select `session.rename`, populate its title, press Run: a separate confirmation appears for potential mutation; Cancel preserves the draft. Confirm yields synthetic result only.
4. Select `github` (stdio): configured and independently probed are distinct. Explicit Test gives a consent reminder before synthetic connection; then its external `search_repositories` Tool displays **Output Schema not advertised** while preserving raw results.
5. Select Config: add/edit/remove definition using adapter-allowed scope. AI only allows user, Claude allows local/project. Invalid URL and name collision do not mutate state; removal requires confirmation.
6. Select Connection: distinguish configured, independently probed/reachable, negotiated protocol, credential binding, and loaded-in-client unknown. External fixture Offline and Missing Credential block run/test; Error fixture produces isError.
7. Switch Web 1180 → App 390 → Web 1024 without refreshing. In App navigate Server list → Tools → Inspector → Runner and back with **host-owned AppPageHeader**. Switch Session through outside control (App) or shell Session list (Web), which clears stale draft/result and reports offline separately from empty.
8. Reset should restore the initial known `AI` fixture and initial viewport. External fixture state is intentionally outside the Nession product UI.

## Preview visual-language correction (2026-11-17)

**Product-owner feedback:** overall information architecture is accepted, but the *actual preview work region* was stylistically arbitrary and did not read like Nession. This revision modifies the **same owning prototype**, not the overall Workspace navigation.

| Before: visual drift | After: Nession design mapping |
| --- | --- |
| Ad-hoc 10px metadata, 12px default body, oversized tool cards | Generated Web/App typography roles: Title, Primary, Body, Secondary, Metadata, Caption, Code; readable technical IDs and input properties |
| Nested bordered panels for Schema, result, and notices | ResourceDetail whitespace-first sections and aligned fact/parameter rows; code tinted only inside Raw blocks; borders only for real input/separation |
| Inspect, Runner, Connection and Config buttons all equally prominent | Contextual **Contract / Run / Connection** local navigation; one primary action in the active operation; secondary actions recede |
| All schemas + args + result + history rendered in one long view | **Contract** is the landing view, **Run** holds the draft and result/history; Output Schema never confused with execution data |
| Uniform Web micro-controls reduced touch legibility on App | Generated App role sizes and control-height tokens (44px touch floor); App host-owned header and depth retained |
| Warning-style card for healthy connection | Connection is quiet secondary context; missing auth/offline becomes a clear local failure without a global banner |

**Design owners inspected:** `web/src/components/ui/resource-detail.tsx`, `configuration-form.tsx`, `operation-surface.tsx`, `button.tsx`, `web/src/shared/typography/chromeRoles.ts`, `web/src/app/workspace/WorkspaceShell.tsx`, `design/generated/web.css`, and the corresponding `docs/design/design-system/patterns` references.

**Verification at this revision:** JavaScript syntax and a synthetic in-memory UI transition harness checked 16 paths: default Contract vs Run, explicit invocation and raw result, cancellation, App depth/Back and Web return, unknown Output Schema and offline blocking. **This is not rendered Chromium/Playwright pixel or focus/touch proof.** Real 1180/1024/390/375 browser measurements, screenshots and Pages manifest HTTPS SHA readback remain Pending.

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

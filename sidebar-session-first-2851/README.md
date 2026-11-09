> **Historical / superseded collapse (2026-11-09):** This #2851 mock preserves the prior 0px fully-tucked-away navigation with an over-work-surface floating reopen control for historical review. The user has approved a new, independently owned **56px in-flow Navigation Rail** and contextual shortcuts in [Requirement #3075](https://github.com/BestNathan/nession/issues/3075). Review the [new interactive rail design](../sidebar-navigation-rail-3075/index.html) for current collapsed-state behavior. #2851's Session-first expanded information architecture still applies. Screenshots/old browser receipts here must **not** be cited as evidence of the new collapsed state.

# Session-first Sidebar · Issue #2851

**Requirement:** https://github.com/BestNathan/nession/issues/2851

## Built-in visual UI specification (primary review experience)
- **Open this prototype's index.html and click “查看 UI 设计标注”** in the preview toolbar, or scroll directly to `index.html#ui-spec`. The visual specification lives **on the same page**; there is no requirement to open GitHub Markdown to see it.
- Select **Sidebar / top actions / toggle / New Session / search / Session row / actions trigger / menu / title / metadata / footer / status dot / drawer / work surface** to inspect the live computed width, height, padding, radius, font weight/size/line height and the canonical token bindings.
- The responsive ruler shows measured navigation/work widths for desktop expanded/collapsed and narrow Web. The color swatches and typography samples are rendered in the review region using the pinned Nession token snapshot.
- “在预览中点选元素” temporarily switches clicks on the product preview to inspection; turn it off to continue using the mock normally. Highlights are **review-only**, never a persistent product chrome.
- Missing elements (collapsed Sidebar, an explicit create form, drawer closed) are marked hidden/unavailable; the inspector never fabricates measurements or claims parity to the production site.
- Browser interaction/cross-viewport verification is still pending; source/static checks are not runtime proof.

## High-fidelity UI specification
- [UI-SPEC.md](UI-SPEC.md) defines the per-component metrics, canonical token owner, proposed changes, state matrix and browser measurements required for #2851.
- The sidebar CSS now consumes a **pinned, local read-only token snapshot** from `design/generated/web.css` at main `0f3b2a012a9203a68ca5f38d56dd1393f6cf74b0`. It is not another token generator or new Nession palette.
- Screen sizes include canonical Web 1280×800 and 1440×900, App-sized **narrow Web drawer** simulations 390×844 and 375×812, plus exploratory Web 1180 and 1024. A phone-sized **Web** preview is not the native App.
- The Terminal/Workspace portions remain illustrative and must not be called high-fidelity or production-matched without real xterm and product fixture comparison.
- **Verification status:** GitHub source/static checks only; real Chromium computed-style/viewport and screenshot comparison not yet performed.

## Design decision to explore

Claude / ChatGPT-inspired, Session-first recent-work navigation. This is a **candidate Web sidebar replacement**, not a screenshot/claim about production. Current main gives the top of \`WebLayout → Sidebar\` to \`SidebarAgents\`, then \`SessionListHeader → SessionList\`, and retains a static-summary collapsed rail. Candidate reverses the emphasis: one toggle, explicit New Session, Search, flat time-grouped Sessions, on-demand Agent context, and a completely tucked-away sidebar.

### Product owner / DOM ancestry / controls
- Current main baseline: \`WebLayout → (Sidebar: SidebarAgents + SessionListHeader + SessionList + SidebarFooter) + ShellMain → Terminal or WorkspacePanel\`.
- Candidate Web wide: \`WebLayout → (Sidebar: top actions + search + Session list + secondary Agent context/Server footer) + ShellMain → Terminal or WorkspacePanel\`.
- Candidate narrow Web: \`WebLayout → SessionDrawer(Sidebar) overlay + ShellMain\`; no permanent rail. The app is **not** depicted as AppLayout.
- \`ShellMain\` still owns the work surface; candidate only changes navigation. The top-right SurfaceSwitcher and bottom Capsule remain shell-owned, not features of the sidebar.
- The candidate Agent entry opens secondary information *in the sidebar*, while Sessions remain a flat return-to-work list.

### Initial state, user goal, end state
- Entry: active \`Fix terminal reconnect\` Session on \`devbox-01\`, Nession Web Shell at 1280×800 CSS px, sidebar expanded.
- Goal: switch work, find a Session, create a new Session, collapse, reopen and explore network/offline infrastructure without treating an Agent as a required Session parent.
- End: same selected Session, with prior search/scroll/list preserved after collapse and re-open. In narrow Web, drawer closes on selection/scrim/explicit close.

### Interaction walkthrough
1. Click another Session; the right work surface adopts its selected identity and sanitized Terminal lines.
2. Search \`sandbox\`, clear input and verify empty-match feedback with \`no-such-session\`.
3. Click **New session**, try empty name and offline \`runner-02\` (negative paths), then explicitly submit a title on online \`devbox-01\`. The local fixture adds/selects it; no remote creation.
4. On **wide Web or narrow Web**, open a Session row's **`···` anchored dropdown**. A row's selection stays unchanged merely by opening the menu; the list remains visible. The trigger is revealed by hover/focus/selection on desktop and stays touch-operable in the narrow drawer.
5. Choose **Session details** to inspect runtime identity (immutable tmux name, Agent/location, workload and state) plus its local metadata.
6. Choose **Edit details** to edit a display title, description and tags (existing #2789 metadata fields). Saving changes the displayed Session title but never `session_name` or `session_id`. Try a blank title (reverts to tmux name), a tag, and the offline Agent (edit unavailable).
7. Choose **Attach settings** to configure local-preview Auto/P2P/Relay mode and renderer. This corresponds to the existing configure intent, not a terminal reconnect.
8. Choose **Kill session**, type its **exact tmux Session name** (not the display title), then confirm. No backend/session termination occurs; this only removes a local fixture.
9. Dismiss the dropdown using Escape, clicking outside or scrolling the list; then collapse and reopen the wide sidebar without losing selected work.
10. Open Agents/locations and check disconnected state independent of Server connectivity. Switch to Narrow 390/375; open/close the drawer and repeat the dropdown flow.
11. Switch between Terminal/Workspace in the mock shell; the Workspace remains illustrative.

### Fidelity and limitations
- **Business fixtures**: sanitized local hardcoded Sessions, Agents, command lines; no credentials or real host addresses.
- **State**: in-browser memory only. Refresh / external Reset resets all changes. No database/Server/WebSocket/tmux/multi-client.
- **Terminal**: plain CSS monospace text representing a shell; **not xterm.js**, not authoritative fixed-col fit, not a PTY. Visual approximation of current light shell. No real attach, recovery, paste, or executable commands.
- **Layout**: outer review frame supplies 1:1 CSS pixel width at 1280, 1440, 1180, 1024, 390, 375; responsive behavior reacts to \`np:resize\` and the **internal** selected width. No CSS transform or zoom. Real browser measured dimensions/pixel parity have **not** been verified.
- **Session actions / approved candidate:** Both wide and narrow Web use **one anchored `···` menu** with `Session details`, `Edit details`, `Attach settings`, `Kill session`. This **changes the current desktop entry point** (main ships inline icons) and adds direct navigation to existing Session metadata workflows (#2789), but does not add an Agent operation or rename tmux. `SessionDetails` / `SessionMetadataSection` remain the canonical data/editing owner; `ShellDialogs` / `AttachDialog` / `KillConfirmDialog` own configure and irreversible operations. The mock uses scoped local overlays for inspectable scenarios; production must reuse existing feature components and state rather than duplicating metadata save logic. No full-sidebar action page.
- **IA delta**: Agent section removed from top by design; a recency-only grouping added to a still-flat Session list; old static summary rail intentionally replaced with full tuck-away. Real product adoption requires updating the canonical design docs/contracts and E2E in a production PR, *not* copying this mock into app.
- **Production owner**: \`web/src/app/experiences/web/WebLayout.tsx\`, \`web/src/app/Sidebar.tsx\`, \`web/src/product/session/patterns/SessionList.tsx\`; product rules in \`docs/design/interaction/web.md\`, \`information-architecture.md\`, \`design-system/patterns/session-list.md\`.
- **Browser**: actual Chromium/Playwright click/keyboard/visual checks **not executed** in authoring environment. The presence of HTML or a publication link is not a browser test.
- **Publication**: \`prototype\` source commit must be pinned after write. Pages URL is **unverified** until HTTPS response and \`prototypes/manifest.json\` record the same SHA. Do not present a constructed preview as live.

### Verification matrix (to be executed)
- Full Web 1280, 1440, 1180, 1024: Session select/search, single row `···` menu, view/edit details, configure and typed-name kill flows, Agent disclosure; expand/collapse actual bounding widths; keyboard focus, no lost current work.
- Narrow Web 390, 375: drawer, scrim, the same anchored four-action menu, 44px menu trigger, full list scrolling and no rail; same page Web → narrow → Web round trip.
- Reviewer browser narrower than 1180: horizontally scroll stage to both edges without scaled/cropped 1:1 viewport; read computed product CSS dimensions.
- Escape/outside-click/list-scroll closes the anchored dropdown; Escape closes local details/configuration/confirmation overlays and drawer; empty Session list after ending all rows is represented without crashing.
- Console/resource load, CSP publish, gallery link, source pin / manifest SHA and static source checks.
- No claim of production E2E or real multi-client Terminal integrity.

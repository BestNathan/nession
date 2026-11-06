# Session-first Sidebar · Issue #2851

**Requirement:** https://github.com/BestNathan/nession/issues/2851

## Built-in visual UI specification (primary review experience)
- **Open this prototype's index.html and click “查看 UI 设计标注”** in the preview toolbar, or scroll directly to `index.html#ui-spec`. The visual specification lives **on the same page**; there is no requirement to open GitHub Markdown to see it.
- Select **Sidebar / top actions / toggle / New Session / search / Session row / title / metadata / footer / status dot / drawer / work surface** to inspect the live computed width, height, padding, radius, font weight/size/line height and the canonical token bindings.
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
4. **Wide Web**: on a selected/hovered/focused Session row, use the existing inline gear **Configure attach settings** or trash **Kill session** icons. The desktop row does **not** acquire a `···` button or switch to a custom Session-actions page.
5. **Narrow Web drawer**: activate the `···` overflow to open the **anchored** menu containing only `Attach settings` and `Kill session`. Outside click / Escape / scroll close it; the Session list remains visible.
6. Configure mode and renderer in the local preview shell-dialog approximation; for Kill, type the **exact Session name** to enable the destructive confirmation, following current main `KillConfirmDialog`. No backend/session termination occurs.
7. Collapse wide sidebar: column returns all width to work, and selected Session stays. Reopen with the floating control.
8. Click Agents / locations; observe Agent connectivity independent of Server status.
9. Select Narrow 390 or 375: open the drawer, close with scrim/button, select a Session. Switch back to desktop Web to retain layout.
10. Switch Terminal/Workspace via the shell surface switcher; Workspace remains only an approximation.

### Fidelity and limitations
- **Business fixtures**: sanitized local hardcoded Sessions, Agents, command lines; no credentials or real host addresses.
- **State**: in-browser memory only. Refresh / external Reset resets all changes. No database/Server/WebSocket/tmux/multi-client.
- **Terminal**: plain CSS monospace text representing a shell; **not xterm.js**, not authoritative fixed-col fit, not a PTY. Visual approximation of current light shell. No real attach, recovery, paste, or executable commands.
- **Layout**: outer review frame supplies 1:1 CSS pixel width at 1280, 1440, 1180, 1024, 390, 375; responsive behavior reacts to \`np:resize\` and the **internal** selected width. No CSS transform or zoom. Real browser measured dimensions/pixel parity have **not** been verified.
- **Session action fidelity**: **Unchanged** from main `web/src/product/session/patterns/SessionItem.tsx`: wide-Web hover/focus/selected inline configure/kill icons; narrow-Web `···` anchored `DropdownMenu` with Attach settings / Kill session. `ShellDialogs` owns the attach-configure and kill-confirmation outcomes; the latter requires exact tmux Session name input. The former custom action panel and mock Open/Rename/End action vocabulary were wrong and have been removed.
- **IA delta**: Agent section removed from top by design; a recency-only grouping added to a still-flat Session list; old static summary rail intentionally replaced with full tuck-away. Real product adoption requires updating the canonical design docs/contracts and E2E in a production PR, *not* copying this mock into app.
- **Production owner**: \`web/src/app/experiences/web/WebLayout.tsx\`, \`web/src/app/Sidebar.tsx\`, \`web/src/product/session/patterns/SessionList.tsx\`; product rules in \`docs/design/interaction/web.md\`, \`information-architecture.md\`, \`design-system/patterns/session-list.md\`.
- **Browser**: actual Chromium/Playwright click/keyboard/visual checks **not executed** in authoring environment. The presence of HTML or a publication link is not a browser test.
- **Publication**: \`prototype\` source commit must be pinned after write. Pages URL is **unverified** until HTTPS response and \`prototypes/manifest.json\` record the same SHA. Do not present a constructed preview as live.

### Verification matrix (to be executed)
- Full Web 1180, 1024: Session select/search/inline configure/kill actions/Agent disclosure; expand/collapse actual bounding widths; keyboard focus, no lost current work.
- Narrow Web 390, 375: drawer, scrim, full list scrolling and no rail; same page Web → narrow → Web round trip.
- Reviewer browser narrower than 1180: horizontally scroll stage to both edges without scaled/cropped 1:1 viewport; read computed product CSS dimensions.
- Escape closes local dropdown/action confirmation/drawer; empty Session list after ending all rows is represented without crashing.
- Console/resource load, CSP publish, gallery link, source pin / manifest SHA and static source checks.
- No claim of production E2E or real multi-client Terminal integrity.

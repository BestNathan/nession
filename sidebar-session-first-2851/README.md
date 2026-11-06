# Session-first Sidebar · Issue #2851

**Requirement:** https://github.com/BestNathan/nession/issues/2851

## Design decision to explore

Claude / ChatGPT-inspired, Session-first recent-work navigation. This is a **candidate Web sidebar replacement**, not a screenshot/claim about production. Current main gives the top of \`WebLayout → Sidebar\` to \`SidebarAgents\`, then \`SessionListHeader → SessionList\`, and retains a static-summary collapsed rail. Candidate reverses the emphasis: one toggle, explicit New Session, Search, flat time-grouped Sessions, on-demand Agent context, and a completely tucked-away sidebar.

### Product owner / DOM ancestry / controls
- Current main baseline: \`WebLayout → (Sidebar: SidebarAgents + SessionListHeader + SessionList + SidebarFooter) + ShellMain → Terminal or WorkspacePanel\`.
- Candidate Web wide: \`WebLayout → (Sidebar: top actions + search + Session list + secondary Agent context/Server footer) + ShellMain → Terminal or WorkspacePanel\`.
- Candidate narrow Web: \`WebLayout → SessionDrawer(Sidebar) overlay + ShellMain\`; no permanent rail. The app is **not** depicted as AppLayout.
- \`ShellMain\` still owns the work surface; candidate only changes navigation. The top-right SurfaceSwitcher and bottom Capsule remain shell-owned, not features of the sidebar.
- The candidate Agent entry opens secondary information *in the sidebar*, while Sessions remain a flat return-to-work list.

### Initial state, user goal, end state
- Entry: active \`Fix terminal reconnect\` Session on \`devbox-01\`, Nession Web Shell at 1180 CSS px, sidebar expanded.
- Goal: switch work, find a Session, create a new Session, collapse, reopen and explore network/offline infrastructure without treating an Agent as a required Session parent.
- End: same selected Session, with prior search/scroll/list preserved after collapse and re-open. In narrow Web, drawer closes on selection/scrim/explicit close.

### Interaction walkthrough
1. Click another Session; the right work surface adopts its selected identity and sanitized Terminal lines.
2. Search \`sandbox\`, clear input and verify empty-match feedback with \`no-such-session\`.
3. Click **New session**, try empty name and offline \`runner-02\` (negative paths), then explicitly submit a title on online \`devbox-01\`. The local fixture adds/selects it; no remote creation.
4. Open a Session's \`···\` overflow, rename, or choose End session and explicitly confirm.
5. Collapse wide sidebar: column returns *all* its width to work. Reopen using the one floating control. The selected Session stays.
6. Click Agents / locations. Observe three distinct Agent health states; \`Server connected\` remains independent of one offline Agent.
7. Select Narrow 390 or 375: open drawer from work, close with its button or scrim, select a Session. Switch back to 1180 to restore real Web two-column composition.
8. Switch the top-right surface controls to Workspace and back. This is a shell-fidelity approximation, not a capability editor.

### Fidelity and limitations
- **Business fixtures**: sanitized local hardcoded Sessions, Agents, command lines; no credentials or real host addresses.
- **State**: in-browser memory only. Refresh / external Reset resets all changes. No database/Server/WebSocket/tmux/multi-client.
- **Terminal**: plain CSS monospace text representing a shell; **not xterm.js**, not authoritative fixed-col fit, not a PTY. Visual approximation of current light shell. No real attach, recovery, paste, or executable commands.
- **Layout**: outer review frame supplies 1:1 CSS pixel width at 1180, 1024, 390, 375; responsive behavior reacts to \`np:resize\` and the **internal** selected width. No CSS transform or zoom. Real browser measured dimensions/pixel parity have **not** been verified.
- **IA delta**: Agent section removed from top by design; a recency-only grouping added to a still-flat Session list; old static summary rail intentionally replaced with full tuck-away. Real product adoption requires updating the canonical design docs/contracts and E2E in a production PR, *not* copying this mock into app.
- **Production owner**: \`web/src/app/experiences/web/WebLayout.tsx\`, \`web/src/app/Sidebar.tsx\`, \`web/src/product/session/patterns/SessionList.tsx\`; product rules in \`docs/design/interaction/web.md\`, \`information-architecture.md\`, \`design-system/patterns/session-list.md\`.
- **Browser**: actual Chromium/Playwright click/keyboard/visual checks **not executed** in authoring environment. The presence of HTML or a publication link is not a browser test.
- **Publication**: \`prototype\` source commit must be pinned after write. Pages URL is **unverified** until HTTPS response and \`prototypes/manifest.json\` record the same SHA. Do not present a constructed preview as live.

### Verification matrix (to be executed)
- Full Web 1180, 1024: Session select/search/dialog/Agent disclosure; expand/collapse actual bounding widths; keyboard focus, no lost current work.
- Narrow Web 390, 375: drawer, scrim, full list scrolling and no rail; same page Web → narrow → Web round trip.
- Reviewer browser narrower than 1180: horizontally scroll stage to both edges without scaled/cropped 1:1 viewport; read computed product CSS dimensions.
- Escape closes local dialogs/drawer; empty Session list after ending all rows is represented without crashing.
- Console/resource load, CSP publish, gallery link, source pin / manifest SHA and static source checks.
- No claim of production E2E or real multi-client Terminal integrity.

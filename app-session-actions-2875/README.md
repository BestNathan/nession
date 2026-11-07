# App Sessions action parity · Requirement #2875

**Requirement:** https://github.com/BestNathan/nession/issues/2875

**Web precedent:** #2851 shipped a Web-only Sidebar. This is a separate App Sessions prototype, not a reduced Web sidebar.

**Direct HTML candidate:** https://bestnathan.github.io/nession/prototypes/app-session-actions-2875/index.html

## Scenario and fidelity contract

**Question:** Can the native App Sessions layer expose the same four Session menu operations as Web without selecting or attaching the wrong Session, while keeping Terminal / Workspace context?

**Current product ancestry, reviewed at staging b52d57cce4a740cc1c96367d50333894c8d688a5:**

| Source owner | App prototype representation |
| --- | --- |
| AppLayout → AppLayers | Terminal stays mounted once; Sessions and Workspace are spatial layers above it |
| AppSessionsSurface → SessionsHeader | One Sessions heading and New Session icon |
| AppSessionsSurface → SessionsChrome | Search, Filter/Sort disclosure, applied chip |
| AppSessionsSurface → SessionsListRegion → SessionList → SessionItem | History groups, two-slot workload/Agent line, 44px action trigger |
| AppSessionsSurface → AgentsDisclosure | Agents below scrollable history, never a Session parent |
| SessionRowActionsMenu | **Candidate delta:** App receives View/Edit/Attach/Kill, instead of shipped two actions |
| SessionDetailsDialog → SessionDetails → SessionMetadataSection | Existing title, description and tags model |
| ShellDialogs → AttachDialog / KillConfirmDialog | Existing configure and exact-tmux-name typed confirmation semantics |
| SessionHeader and WorkspacePanel / AppPageHeader | Terminal-to-Sessions affordance and Workspace's single Back action |

**Visual token baseline:** design/generated/web.css blob 079b059836d994bbb20f65e288e5ec4599e1aab3, App titles 17px, primary 16px, body 14px, metadata 12px, control floor 44px, 7px Session row radius and padding. These values come from Nession, not an independent palette.

## Walkthrough

1. Open App Sessions at 390×844. The preselected Terminal Session is Fix terminal reconnect; its Terminal is mounted but covered by the Sessions spatial layer.
2. Open the overflow menu on the **unselected Design Files workspace** row. Four entries appear: Session details, Edit details, Attach settings, Kill session. Opening the menu does not select this row or remount Terminal.
3. Choose Session details and examine immutable tmux name/Session ID alongside editable work metadata. Close and remain in Sessions.
4. Choose Edit details, update Title/Description/Tags and save. Navigation alias changes, tmux Session name does not. Clearing title restores the tmux fallback.
5. Configure Auto/P2P/Relay and WebGL/Canvas without auto-attaching. Try Kill with a display title (rejected) and with exact tmux name (unlocks). Cancel and confirm are distinct.
6. Tap row text instead of the menu to return to Terminal; from Terminal use Sessions and Workspace buttons, with a single Back from Workspace. The Terminal DOM is not replaced.
7. Try searching, online/offline filters, empty results, Agents disclosure and menu dismissal by scroll/Escape/outside click. Switch to 375×812 and 430×932 without scaling; Reset restores local fixtures.
8. External fixtures: Agent offline allows reading details but blocks editing; Save conflict rejects the first save and requires reload; No Sessions presents an explicit creation path.

## Fidelity and limitations

- **Fixtures:** sanitized Session/Agent names and data are local JavaScript objects; create/save/kill modify only in-memory state. No Server/Agent/auth/API/tmux/SSH calls.
- **App:** full-size product-content CSS pixel widths and heights (375×812, 390×844, 430×932) and spatial layer ownership. Not a pixel-equal React/shadcn or native iOS/Android rendering.
- **Terminal:** plaintext illustrative output, not xterm.js or an actual PTY. No TUI, OS keyboard/IME, real swipe paging or fixed-column fitter validation.
- **Metadata:** user-facing title alias, description, tags, revision conflict and offline state are modeled; real Agent persistence/metadata cache, CAS and reconnection behavior are not tested.
- **Design documentation:** the same HTML contains the UI spec inspector below the preview; use the review-only controls to inspect actual DOM geometry/font/visibility. Companion UI-SPEC.md records product owners and acceptance boundaries.
- **Verification:** GitHub source/static checks must be separated from Chromium interaction proof; a Pages branch push is not proof that the exact revision has published. Confirm published prototypes/manifest.json SHA before claiming the current HTML is live.
- **Production acceptance:** #2875 SCs remain Pending until the implementation's own trusted App browser Cases pass. #2851 Web evidence cannot prove them.

## Browser regression checklist (not yet executed unless evidenced)

At 390×844 and 375×812: menu trigger measures at least 44×44 CSS px; popup is not clipped or off-screen; four menu options are keyboard and touch operable; scroll closes menu, Escape restores focus, and opening an unselected row's menu does not alter the active Terminal. Test edit save/cancel, offline/conflict, alias-versus-tmux kill confirmation, filtering/empty, returning to Terminal/Workspace and a viewport switch on the same page. Compare production App screenshots/geometry against FixtureApp separately before claiming visual parity.

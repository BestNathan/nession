# UI Spec — App Sessions four-action menu (#2875)

## Product contract

App remains **Sessions ← Terminal → Workspace**, not a Web Sidebar. Session row text selects work; its separate 44px More control reveals a floating four-item menu without selecting or remounting the underlying active Terminal.

Baseline: AppLayout, AppLayers, AppSessionsSurface, SessionList, SessionItem and SessionDetailsDialog on staging b52d57cce4a740cc1c96367d50333894c8d688a5. Visual token snapshot: design/generated/web.css blob 079b059836d994bbb20f65e288e5ec4599e1aab3.

## Component metrics and interaction states

| Component | Target metric | State/action |
| --- | --- | --- |
| Product viewport | 375×812 / 390×844 / 430×932 CSS px (unscaled) | Current App spatial shell |
| App Sessions header | 17px title, weight 600; New Session control 44px | Single page title, no global branding or Web rail |
| Search and Filter | 44px touch floor, Filter disclosure and applied chip | Hidden advanced controls at rest |
| Session row | 7px vertical padding and radius; primary 16px/550, metadata 12px/475 | Selection background only; grouped by recency without duplicate row time |
| More button | Minimum 44×44px and always accessible in App | Opens anchored menu without selecting Session |
| Menu | Four options each minimum 44px; separator before destructive Kill | Escape, outside click, App-owned list scroll dismiss; keyboard arrows |
| Details | Read target Session's immutable runtime identity plus work metadata | No side effect on active Session |
| Edit | Title ≤120 Unicode scalars; description ≤2000; ≤12 tags of ≤32 each | Offline edit unavailable, revision conflicts explicit, tmux immutable |
| Attach settings | Existing configure intent, mode and renderer | No automatic attach |
| Kill | Typed exact underlying tmux name | Display title alone cannot unlock |
| Agents | One expandable entry below history | Infrastructure subordinate to Sessions |
| Workspace | App contextual depth and one Back control | Returns to same mounted Terminal |

## Test state matrix

- Initial: active Session plus recent/historical Sessions including one offline Agent. Show workload and Agent; avoid repeated per-row recency when history is grouped.
- Nonselected Session menu: active selection remains unchanged; four items available, visually separated Kill.
- Read/edit: unchanged immutable tmux name and Session ID; alias edits propagate to list; blank title falls back; unavailable Agent prevents saving; mock revision conflict offers reload.
- Kill: default disabled, typed alias invalid, exact tmux name enables; Cancel does not mutate anything; confirmation deletes only mock fixture.
- Filter/search/empty: clear controls, offline discoverability and secondary Agents detail remain reachable.
- Navigation: Terminal persists under Sessions and Workspace, no Web collapse/rail/drawer. A secondary modal does not transform the App Sessions list into a full-sidebar actions page.

## Visual inspector and evidence

The interactive HTML includes an in-page reviewer component picker that reads the actual preview's computed DOM size, type, radius, color and visible state; it is explicitly **outside** the product viewport. Full-size CSS pixels and token reuse do not prove production parity. Before accepting #2875, run trusted Chromium Playwright on the real App at 390 and 375 with click, keyboard, scroll, touch, focus, modal validation and session continuity assertions. Review screenshots against FixtureApp and record any differences.

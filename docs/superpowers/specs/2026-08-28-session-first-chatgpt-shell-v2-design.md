# Session-first ChatGPT Shell — V2 Design (History Sidebar)

**Issue:** [#492](https://github.com/BestNathan/nession/issues/492)  
**Parent design:** [`2026-08-28-session-first-chatgpt-shell-design.md`](./2026-08-28-session-first-chatgpt-shell-design.md)  
**Depends on:** V1 on `staging` (light shell + thin header + `TerminalWell` + header overflow)  
**Status:** Draft for review  

---

## Goal

Ship **V2** of the ChatGPT-style shell: quiet **session history** sidebar (rows + create CTA + search), relocate Env / ServerInfo / Legacy into a **sidebar footer** overflow, and leave the top chrome as brand + connection badge only.

Flag stays **off** until #472 PR7. Validate with `?session_first=1`.

---

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Overflow placement | **Sidebar footer** — move `SessionFirstOverflowMenu` out of the header |
| Row kill | **Hover-reveal** Kill button on the row (no always-visible trash; no row `⋯`). Existing kill confirm dialog unchanged |
| Search / filters / sort | **Search always visible**; All/Online/Offline + Name/Activity sort behind one compact disclosure |
| Implementation | **Restyle-in-place** on existing `SessionList` / `SessionItem` / `SessionListHeader` / sidebar APIs |

---

## Chrome split

### Top header (`SessionFirstChrome`)

- **Keep:** Nession title + `ConnectionStatusBadge` + dismissible error banner  
- **Remove:** Header `⋯` / `SessionFirstOverflowMenu`  
- Spacing stays calm (V1 thin bar)

### Sidebar footer (new)

- Pinned to the bottom of `SessionFirstSidebar`  
- Hosts the existing `SessionFirstOverflowMenu` (Env / ServerInfo / Legacy)  
- Optional compact connection hint is **not** required if the badge remains in the header  
- Footer must not steal vertical space from the scrollable history list beyond a single compact row (~40–48px)

---

## History list + rows

### List header (`SessionListHeader`)

- **New Session:** primary rounded CTA (visible label on desktop; icon-only acceptable when width is tight)  
- **Search:** always visible  
- **Filters + sort:** collapsed behind one compact control (filter icon or “Filters” disclosure). Default closed. Opening reveals All / Online / Offline and Name / Activity sort controls (same behaviors as today)

### Rows (`SessionItem`)

- Primary: session name  
- Secondary: `shell · {agent} · {relative time}`  
- Unhealthy agent: existing quiet copy / channel styling  
- Selected: light muted background, `rounded-lg` (~8–12px), no left color rail  
- Actions: **Kill** icon button revealed on **row hover** (and `focus-within` / keyboard focus so it stays reachable without a pointer). Quiet ghost styling — not a permanent red outline control  
- Touch / no-hover: also show actions when the row is **selected** (or via `focus-within`) so mobile is not stuck without Kill until V4 polish  
- Kill still calls the existing parent `onKill` → confirm dialog path. Tooltip / `aria-label` on the button

### List chrome (`SessionList`)

- Calmer padding / gaps; loading skeletons sized to the new row  
- Sort header row removed from the default always-visible chrome (lives in the disclosure)  
- No Projects / Pins / nav trees

---

## Approach

Restyle and relocate within current session-first patterns. Do **not** introduce a parallel `HistorySidebar` or CSS-only half-measure.

---

## Files (plan will lock)

| Area | Touch |
|------|--------|
| Chrome | `SessionFirstChrome.tsx` (+ tests) |
| Sidebar | `SessionFirstSidebar.tsx` — footer host |
| Overflow | Reuse `SessionFirstOverflowMenu.tsx` |
| List | `SessionListHeader.tsx`, `SessionList.tsx`, `SessionItem.tsx` (+ integration tests) |

---

## Acceptance

- [ ] `?session_first=1`: history sidebar quieter; search visible; filters/sort collapsed by default  
- [ ] Row `⋯` opens Kill; kill confirm still works  
- [ ] Env / ServerInfo / Legacy reachable from **sidebar footer** only (not header)  
- [ ] Header shows brand + badge only (plus error banner when present)  
- [ ] Attach, Workspace, Agent (Claude Code), deep link unchanged  
- [ ] `just web-lint` / `just web-test`; Playwright screenshots on the PR  
- [ ] `session_first` default still **off**

---

## Non-goals

- Floating Input/Commands capsule (**V3**)  
- Narrow viewport list XOR detail polish (**V4**)  
- `#472` cutover / default-on (**PR7**)  
- Legacy Dashboard restyle  
- ChatGPT Projects / Plugins / Pins trees  

---

## Delivery

| PR | Scope |
|----|--------|
| **V2** (this doc) | History rows + create CTA + filter disclosure + sidebar footer overflow |
| V3 | Capsule |
| V4 | Mobile polish |
| Then | #472 PR7 |

Worktree base: `origin/staging`. PR base: `staging`.

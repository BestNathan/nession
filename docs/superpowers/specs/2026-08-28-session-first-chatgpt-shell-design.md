# Session-first ChatGPT-style Visual Shell Design

**Date:** 2026-08-28  
**Status:** Approved (awaiting implementation plan)  
**Requirements:** GitHub Issue [#492](https://github.com/BestNathan/nession/issues/492)  
**Parent:** [#472](https://github.com/BestNathan/nession/issues/472) (capability migration), [#468](https://github.com/BestNathan/nession/issues/468)  
**Related:** [#467](https://github.com/BestNathan/nession/issues/467) (executable tokens), [#470](https://github.com/BestNathan/nession/issues/470) (pattern specs)  
**Depends on:** Session-first shell on staging through #472 PR6 (lifecycle → mobile)

---

## Overview

Session-first **information architecture is accepted**. Remaining work before default cutover is a **visual / interaction shell**: ChatGPT-like light chrome, quieter sidebar, thin session header, dark terminal “well,” and a floating capsule for Input / Quick Commands.

This is **not** a chat product. The metaphor is layout density and calm chrome; the objects remain Session, Terminal, and Workspace.

**Sequencing:** Finish this visual pass (V1–V4) under `session_first` flag (default still off). **Then** #472 PR7 flips the default on.

---

## Key Decisions

### 1. Scope = visual language + layout + capsule (all three)

| Layer | Decision |
|-------|----------|
| Visual language | Light shell, generous spacing, soft radii (~8–16px), quiet chrome |
| Layout | Sidebar as session “history,” thin top bar, main area for Terminal/Workspace |
| Capsule | Floating bottom bar for Input / Commands on Terminal surface only |

### 2. Light shell + dark xterm

- Chrome, sidebar, Workspace: **light** semantic surfaces  
- Terminal viewport: **dark well** (Catppuccin Mocha unchanged) with rounded inset against the light shell  
- Not a full dual-theme ship in V1–V4 (dark shell optional later)

### 3. Separate issue from #472 PR7

Capability migration (#472 PR1–6) stays as-is. Visual shell is its own requirement + PR series. Cutover (PR7) waits until V1–V4 pass staging review.

### 4. IA and protocol frozen

- No change to Session-first IA (`docs/design/`)  
- No Rust / protocol changes  
- No chat transcript, voice waveform CTA, or AI-runtime chrome  
- Env / Files stay out of the capsule (Workspace / sidebar overflow)

### 5. Tokens

Prefer Semantic / Domain / Experience (#467). V1 may use existing semantic Tailwind + scoped shell CSS if executable token codegen is not ready; do not introduce Primitive palette literals on new surfaces.

---

## Shell composition

```text
┌─ Light sidebar (≈260–280px) ─┬─ Light main ─────────────────────────┐
│ Brand + icon tools            │ Thin session chrome                   │
│ [ + New Session ]             ├───────────────────────────────────────┤
│ Recent sessions (history UI)  │ Dark Terminal well  XOR  Workspace    │
│                               │                                       │
│ Footer: connection · overflow │ Floating capsule (Terminal only)      │
└───────────────────────────────┴───────────────────────────────────────┘
```

Narrow (&lt; `lg`): keep #472 PR6 **list XOR detail**; same visual language.

---

## Sidebar + Session rows

- Primary CTA: **New Session** (rounded, calm) — not a dense toolbar of filters  
- Rows: session name primary; `workload · agent · relative time` secondary  
- Selected: light gray rounded block (~8–12px), no loud color rail  
- Healthy Agent: quiet; unhealthy: blame **Agent** in metadata / compact badge  
- Kill / overflow on hover or `⋯`  
- Search / filter / sort collapsed into search or overflow by default  
- Footer: connection + Env / ServerInfo / Legacy in overflow — not a crowded top chrome  

Non-goal: ChatGPT nav trees (Projects, Plugins, Pins). Sidebar = session history + create.

---

## Top chrome + surfaces

**Header (thin):**

- Session title; AgentContext quiet when healthy  
- Compact Terminal | Workspace SurfaceSwitcher  
- Back-to-sessions only when sidebar hidden / mobile detail  
- ConnectionStatus compact by default (expand for three channels)  
- Env / ServerInfo / Legacy **not** in the header  

**Terminal well:**

- Rounded dark inset (~12–16px) in light main  
- Maximize xterm height; reconnect banners inside the well  
- Attach / keep-alive / deep-link behavior unchanged  

**Workspace:**

- Light surface + WorkspaceNavigation (Files | Session | Agent)  
- Same radius/spacing as shell; Claude Code remains on Agent tool  
- No permanent Terminal | Files split  

---

## Floating capsule (Input / Commands)

Terminal surface only. Reuses InputPanel / QuickCommands semantics — **not** a chat composer.

**Collapsed (default):** floating pill above bottom safe area — overflow (`+`), single-line send, mode pill (`Input` / `Commands`), send / shortcuts.

**Expanded:** light sheet (~28–32vh) above the pill with existing panel content; xterm keep-alive preserved.

| Forbidden in capsule | Where it lives |
|----------------------|----------------|
| Env tab | Sidebar overflow / Env manager |
| Files tab | Workspace → Files |
| Voice / waveform send | Out of scope |

`toolbarDisabled` disables the whole capsule. Desktop and mobile share one component; mobile keeps larger hit targets and #472 `terminalOnly` (no swipe Files/Env).

---

## Delivery

| PR | Scope |
|----|--------|
| **V1** | Light shell tokens/chrome; thin header; dark Terminal well |
| **V2** | SessionList / SessionItem history styling; sidebar footer overflow — see [`2026-08-28-session-first-chatgpt-shell-v2-design.md`](./2026-08-28-session-first-chatgpt-shell-v2-design.md) |
| **V3** | Floating capsule; retire session-first BottomBar path — see [`2026-08-28-session-first-chatgpt-shell-v3-design.md`](./2026-08-28-session-first-chatgpt-shell-v3-design.md) |
| **V4** | Narrow viewport polish (list XOR detail + capsule) |
| **Then** | #472 **PR7** — `session_first` default on |

Flag remains off until PR7. Validate on staging with `?session_first=1`.

### Acceptance

- [ ] Desktop: light shell, quiet sidebar, thin header, dark well, capsule on Terminal  
- [ ] Mobile 375: same language; list XOR detail; no ModeBar Files/Env swipe  
- [ ] Attach, Workspace Files, Agent (Claude Code), deep link still work  
- [ ] `just web-lint` / `just web-test`; Playwright screenshots on PRs  
- [ ] No chat transcript / AI runtime chrome  

### Non-goals

- App spatial model (#473)  
- Legacy Dashboard restyle  
- Executable token codegen completion (#467) as a hard blocker for V1  
- Default cutover before V1–V4 review  

---

## File sketch (plan will lock)

| Area | Likely touch |
|------|----------------|
| Shell chrome / theme | `SessionFirstChrome`, `SessionFirstWorkspace`, `index.css` / shell tokens |
| Sidebar / rows | `SessionFirstSidebar`, `SessionList`, `SessionItem`, `SessionListHeader` |
| Header / surfaces | `SessionHeader`, `SurfaceSwitcher`, `SessionFirstMain` |
| Capsule | New pattern under `session-first/` or `components/`; wire via `SessionFirstTerminal` / `TerminalLayout` |
| Mobile | `useSessionFirstMobileNav`, `MobileTerminalLayout` `terminalOnly` path |

Architecture contracts remain in [`docs/design/`](../../design/README.md). This spec adds the **Web visual shell** target for session-first only.

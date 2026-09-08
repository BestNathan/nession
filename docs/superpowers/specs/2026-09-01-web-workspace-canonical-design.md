# Web Workspace — Canonical Screen(插件框架 + AI 风壳)

**Date:** 2026-09-01
**Status:** Approved (brainstorming)
**Umbrella:** [#561](https://github.com/BestNathan/nession/issues/561) Phase 2B
**Upstream:** [visual-language.md](../../design/visual-language.md) · [composition.md](../../design/composition.md) · [workspace.md](../../design/workspace.md) · [interaction/web.md](../../design/interaction/web.md) · [interaction/app.md](../../design/interaction/app.md)
**Pattern specs:** [workspace-navigation.md](../../design/design-system/patterns/workspace-navigation.md) · [file-workspace.md](../../design/design-system/patterns/file-workspace.md)
**Branch:** `feat/web-workspace-canonical` (base: `origin/staging` — includes merged 2A)

---

## Goal

Produce the **Web Workspace / Files canonical screen** at `1440 × 900` and the workspace plugin framework that hosts it, on top of the 2A terminal-native shell.

Primary design question (from #561):

> Does Workspace feel like an auxiliary Session surface rather than a second application shell?

Approved answer: **Workspace is a work area with its own identity** — entering it feels like switching to a tool application of this Session. Its chrome is a **bottom floating tool bar** (the sibling of the terminal input capsule), its tools are **plugins** with their own Web/App layouts, and its surface carries its own ground level. The surrounding Web shell moves **AI-style**: the Sessions sidebar becomes a drawer, the screen is full-bleed Terminal by default.

## Web shell — AI-style (drawer sessions)

### Default state (Terminal surface)

```text
┌────────────────────────────────────────────────────────────────────┐
│ [≡]  fix-terminal-reconnect · online · active · attached           │
│                                        [Terminal | Workspace]  ●   │ ← 唯一常驻行
│                                                                    │
│                        TERMINAL (全屏,唯一亮面)                     │
│                                                                    │
│                          [ 输入胶囊  ▸ ]                            │
└────────────────────────────────────────────────────────────────────┘
```

- Top row (evolved from 2A's session line): `[≡]` drawer button + session name + muted state fragments + right-aligned `[Terminal | Workspace]` switcher + server micro-status. **This is the only persistent chrome.**
- Sessions sidebar is **removed** from the resting layout; Terminal is full-bleed.
- The 2A `SessionList` / `SessionItem` / `SessionListHeader` components move into a **drawer**: `[≡]` opens a left overlay (scrim + slide-in, reusing the existing mobile drawer logic from `useSessionFirstMobileNav`). The drawer holds search / filter / create / session rows / server status.
- Drawer interactions are the same as 2A's sidebar (selection = accent bar, hover disclosure, kill behind confirm).

### App

- `[Terminal | Workspace]` (SurfaceSwitcher) must **not render in the App experience** — App uses the spatial model (`Sessions ← Terminal → Workspace`, gestures + visible controls), the switcher is Web chrome. 2A left this shared; this phase adds the experience gate.

## Workspace surface

```text
┌────────────────────────────────────────────────────────────────────┐
│ [≡]  fix-terminal-reconnect · online · active · attached           │
│                                        [Terminal | Workspace]  ●   │
│ ┌───────────────┬──────────────────────────────────────────────┐  │
│ │ 文件树        │ 编辑器                                       │  │  ← 工具内容(插件布局)
│ │ src/          │ 代码…                                        │  │
│ └───────────────┴──────────────────────────────────────────────┘  │
│            ┌──────────────────────────────────┐                   │
│            │ 📁 Files · 📄 Session · 👤 Agent  │                   │ ← 底部浮动工具条
│            └──────────────────────────────────┘                   │
└────────────────────────────────────────────────────────────────────┘
```

- **Surface identity**: the workspace content area sits on its own ground level — one step darker than the canvas (`--muted` tier), forming a three-level ladder: canvas (lightest) → workspace (mid) → terminal (darkest).
- **Bottom floating tool bar**: rounded, elevated, token-styled — the sibling of the terminal input capsule (same radius/elevation/token family). It renders the tool registry (label / icon / order / availability; disabled tools are inert, hidden tools leave no empty chrome — per [workspace.md](../../design/workspace.md) availability rules). It is the workspace's only floating element.
- The top row stays visible on the Workspace surface (switch back anytime).

## Workspace plugin framework

### Tool contract

```ts
// web/src/session-first/workspace/toolTypes.ts
export interface WorkspaceContext {
  session: Session | null;
  agent: Agent | undefined;
  domain: DomainState | null;
  fileOps: FileOps | null;
  experience: 'web' | 'app';
  onToolChange: (id: WorkspaceToolId) => void;
}

export interface WorkspaceTool<Ctx = WorkspaceContext> {
  id: WorkspaceToolId;                        // unique across the registry
  label: string;                              // tool-bar label
  icon: LucideIcon;                           // tool-bar icon
  order: number;                              // tool-bar sort
  availability: (ctx: Ctx) => boolean;        // e.g. Files needs fileOps
  layout: {
    web: React.ComponentType<{ ctx: Ctx }>;   // Web layout, owned by the tool
    app: React.ComponentType<{ ctx: Ctx }>;   // App layout, owned by the tool
  };
}
```

- One file per tool under `web/src/session-first/workspace/tools/` (`files.tsx`, `session.tsx`, `agent.tsx`), plus a registry module that aggregates them (`tools/index.ts`).
- Adding a tool = add a file + one registry line; the framework (shell, tool bar, container) does not change.
- The File browser is exactly this: the `files` tool plugin (web layout = tree | editor, app layout = tree full-screen → push editor).

### Framework (container) responsibilities

- Build the bottom tool bar from the registry (order / icon / label / availability → disabled state).
- Render the active tool: `tools[active].layout[ctx.experience]`.
- Provide `ctx` (session / agent / domain / fileOps / experience / onToolChange).
- The tool content area is a framework-owned container; the tool's own layout fills it.

### Layout constraints (no fixed pixels)

- Tool-internal layouts must not use fixed px for structural geometry — **proportions and grids**: Files web layout = CSS grid (tree `1fr` / editor `2fr`, or minmax that narrows gracefully); tool bar width = content-driven; spacing from `--sf-space-*` / Experience tokens.
- Web/App differences live in `layout.web` / `layout.app` — never scattered `if (mobile)` metrics inside a shared component.

### Initial tools

| Tool | web layout | app layout |
|------|-----------|------------|
| Files | grid: tree (1fr) ‖ editor (2fr), hairline divider | tree full-screen → push editor on select |
| Session | single detail surface | single detail surface (push) |
| Agent | single detail surface (connection state) | single detail surface (push) |

FileBrowser / FileViewer keep their own compact chrome inside the tool (the plugin owns its interior); their heavier tool bars are converged to one quiet line per pane.

## Fixture

- Keep the 2A terminal fixture unchanged.
- Add a **workspace fixture variant**: `surface='workspace'`, `tool='files'`, deterministic file tree (a realistic project layout) + editor content; plus a **drawer-open state** (sessions drawer deterministically rendered open) for the shell.
- The workspace fixture exercises the plugin framework end-to-end (registry → tool bar → files tool layout).

## Docs sync (same PR)

- `docs/design/composition.md`: shell geometry — no persistent sidebar; top row is the only chrome; workspace ground level; bottom floating tool bar.
- `docs/design/workspace.md`: tool registry contract gains the `layout.web/app` split and the no-fixed-px constraint.
- `docs/design/visual-language.md`: surface hierarchy — workspace ground tier; floating control surface now hosts both the terminal capsule and the workspace tool bar.
- (Release note: these files already conflict at staging→main from 2A; superset resolution continues.)

## Out of scope

- App screen itself (Phase 2C) — the `layout.app` slots are defined by the contract and filled minimally, but the App canonical screen is a later phase.
- Drawer deep-linking, keyboard shortcuts for tools (later polish).
- New tools (Git / Preview / Processes) — the registry must make them trivial, but they are not built here.

## Acceptance

- [ ] Resting Web shell = top row + full-bleed Terminal; no persistent sidebar.
- [ ] `[≡]` drawer opens the session list (scrim + slide-in); selection/actions work as in 2A.
- [ ] App experience does not render `[Terminal | Workspace]`.
- [ ] Workspace surface has its own ground tier and a bottom floating rounded tool bar (capsule-family tokens).
- [ ] Tools are registry plugins with `layout.web` / `layout.app`; adding a tool = one file + one registry line.
- [ ] Tool layouts use proportions/grids, no fixed px for structure.
- [ ] Files tool renders tree ‖ editor at 1440×900 with deterministic fixture data.
- [ ] Playwright browser verification at 1440×900 (terminal, workspace, drawer states) + screenshots for approval.
- [ ] Docs updated to match the approved screen and framework.

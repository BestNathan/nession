# Nession UI Design Protocol

**Date:** 2026-08-08
**Status:** superseded for product model / IA / interaction — see [`docs/design/`](../../design/README.md) (UI Architecture v2, [#468](https://github.com/BestNathan/nession/issues/468) / [#469](https://github.com/BestNathan/nession/issues/469)). Visual-direction notes below remain useful until [#467](https://github.com/BestNathan/nession/issues/467) lands executable tokens; where they conflict, `docs/design/` and #467 win.

**Do not implement the layout in §3 or the mobile pager from this file.** Those sections describe the shipping Agent-first / Terminal+Files shell. New IA and interaction work follows `docs/design/`.

---

## 1. Design Discovery

| Dimension | Answer |
|-----------|--------|
| Product | 分布式 tmux agent — Web 浏览器管理远程终端 |
| Primary user | 运维/开发者，需要手机/桌面快速管理远程服务器 |
| Primary action | 查看和交互 tmux 终端会话 |
| Secondary actions | 浏览/编辑文件、管理环境变量、attach/detach/kill 会话 |
| Primary information | 终端输出（xterm.js） |
| Secondary information | 文件浏览器 + 文件查看器/编辑器、环境变量列表 |
| Interaction flows | Login → Dashboard → AttachDialog → TerminalView |

---

## 2. Visual Direction

```
personality:    technical — 精密仪器，不是消费 app
density:        compact — 终端天生密集
visual_weight:  heavy — 暗色背景 + 尖锐亮色强调
contrast:       high — 终端内容需要最高可读性
hierarchy:      Terminal > Files > Envs > Metadata > Actions
aesthetic:      terminal-native — 从 tmux/vim/CLI 借语言
```

**Signature risk**: UI 是终端的边框。所有 chrome（headers, tabs, indicators）应该感觉它们可以在终端里渲染。ModeBar（2px 线）是第一个表达。

**Palette discipline**: 只用 shadcn dark theme 语义 token。唯一强调色是 `primary`（phosphor green）。不引入第二个强调色。

---

## 3. Layout Model

### App Shell (Desktop ≥1024px)

```
┌──────────────────────────────────────────────────────────┐
│ TerminalHeader                    h-12, border-b, px-4   │
│ [←Back] [Session▼] [P2P▾] [Addr...]                     │
├──────────┬───────────────────────────────────────────────┤
│ SidePanel│ MainContent                                   │
│ 20%      │ 80%                                           │
│ (15-35%) │                                               │
│          │ ┌─ FileTabBar ───────────────────────────────┐│
│ File     │ │ [Terminal] [app.log] [config.yaml]         ││
│ Browser  │ └────────────────────────────────────────────┘│
│          │                                               │
│          │ ┌─ Content (flex-1) ─────────────────────────┐│
│          │ │ Terminal (xterm.js)  |  FileViewer         ││
│          │ │                                            ││
│          │ └────────────────────────────────────────────┘│
│          │ ┌─ BottomBar (h-9) ──────────────────────────┐│
│          │ │ Input | Commands                            ││
│          │ └────────────────────────────────────────────┘│
└──────────┴───────────────────────────────────────────────┘
```

### App Shell (Mobile <1024px)

```
┌─────────────────────────────────────┐
│ TerminalHeader     h-12, border-b   │
│ [←] [Session▼] [P2P]               │
├─────────────────────────────────────┤
│ ┌─ ModeBar (2px, absolute top) ───┐ │
│ │████████░░░░░░░░░░░░░░░░░░░░░░░░░│ │ ← primary segment, 1/3 width
│ └─────────────────────────────────┘ │
│                                     │
│ Panel 0: Terminal (full-bleed)      │
│ ┌─ xterm.js ──────────────────────┐ │
│ │                                  │ │
│ │                                  │ │
│ └──────────────────────────────────┘ │
│ ┌─ TerminalInputBar (collapsible) ─┐ │
│ │ ▲ Input & Commands  [^C] [⌧]    │ │
│ └──────────────────────────────────┘ │
│                                     │
│ Panel 1: Files                      │
│ ┌─ Header: "Files" (h-7) ─────────┐ │
│ ├─ FileViewer (60%) ──────────────┤ │
│ ├─ FileBrowser (40%, collapsible) ─┤ │
│ └──────────────────────────────────┘ │
│                                     │
│ Panel 2: Envs                       │
│ ┌─ Header: "Environment" (h-7) ────┐ │
│ └─ KEY=VALUE list ────────────────┘ │
└─────────────────────────────────────┘
```

### Responsive Degradation

```
>= 1024px (Desktop):
  sidebar:       ResizablePanel, 20% default, 15-35% range
  file_tabs:     Tabs above content
  bottom_bar:    Input | Commands
  terminal:      inside ResizablePanel main content
  file_browser:  SidePanel (always visible)

< 1024px (Mobile):
  sidebar:       removed
  file_tabs:     removed (no file tabs)
  bottom_bar:    replaced by TerminalInputBar
  terminal:      SwipeableViewport Panel 0 (full-bleed)
  file_browser:  inside FilesPanel (60/40 split) or BottomBar Files tab
  navigation:    ModeBar (top) + swipe between 3 panels
```

---

## 4. Design Tokens

### Spacing

| Token | Value | Usage |
|-------|-------|-------|
| `1` | 4px | Tight icon/text grouping, dot indicators |
| `2` | 8px | **DEFAULT gap**, button px, item gap |
| `3` | 12px | Section px, card padding |
| `4` | 16px | Header px, section gaps |
| `6` | 24px | Page-level padding |
| `8` | 32px | Page margins (rare) |

### Typography

| Token | Tailwind | Size | Usage |
|-------|----------|------|-------|
| caption | `text-xs` | 12px | Labels, metadata, badges |
| **body** | **`text-sm`** | **14px** | **DEFAULT — all UI text** |
| body-lg | `text-base` | 16px | Login inputs, rare labels |
| heading | `text-lg` | 18px | Card titles, section headers |
| display | `text-3xl` | 30px | Login page title only |

**Font families**: Inter (UI), JetBrains Mono (terminal)

### Radius

| Token | Value | Usage |
|-------|-------|-------|
| none | 0 | Terminal panels, ModeBar, TabBar rows |
| sm | 4px | Inputs, badges |
| md | 6px | Buttons, cards |
| lg | 8px | Dialogs |

### Heights & Dimensions

| Token | Value | Tailwind | Usage |
|-------|-------|----------|-------|
| page-header | 48px | `h-12` | TerminalHeader, page headers |
| section-header | 40px | `h-10` | Collapsible section headers |
| toolbar | 36px | `h-9` | Input bars, toolbars |
| tab-row | 32px | `h-8` | TabBar, BottomBar |
| panel-header | 28px | `h-7` | Mobile panel headers |
| icon-sm | 12px | `size-3` | Icons inside buttons |
| icon-md | 16px | `size-4` | Standalone icons |
| mode-bar | 2px | `h-[2px]` | Signature indicator |

### Colors

All from shadcn semantic tokens. No raw hex values in components.

| Role | Token |
|------|-------|
| Page background | `bg-background` |
| Elevated surface | `bg-card` |
| Muted surface | `bg-muted` / `bg-muted/20` |
| Borders | `border` (CSS var) |
| Primary text | `text-foreground` |
| Secondary text | `text-muted-foreground` |
| Accent/Active | `bg-primary` / `text-primary-foreground` |
| Destructive | `bg-destructive` / `text-destructive` |

---

## 5. Component Structure

### Layout Components (by visual responsibility)

```
AppShell
├── LoginPage              — centered card form
├── Dashboard              — agent grid + session list
│   ├── AgentsSection      — collapsible, SummaryBar toggle
│   └── SessionList        — scrollable rows
├── TerminalView           — full-screen terminal
│   ├── TerminalHeader     — back, session, connection
│   │   ├── SessionDropdown
│   │   └── AddressSelector
│   └── TerminalLayout     — responsive orchestrator
│       ├── [Desktop] FileTabs
│       │   ├── SidePanel (FileBrowser)
│       │   ├── FileTabBar (Tabs)
│       │   └── BottomBar
│       └── [Mobile] MobileTerminalLayout
│           ├── SwipeableViewport
│           │   └── ModeBar (signature)
│           └── TerminalInputBar
└── Dialogs
    ├── AttachDialog
    ├── CreateSessionDialog
    └── KillConfirmDialog
```

### Naming Convention

- **Layout**: `*Layout` (TerminalLayout, MobileTerminalLayout)
- **Panel**: `*Panel` (SidePanel, FilesPanel, EnvPanel, InputPanel)
- **Bar**: `*Bar` (BottomBar, ModeBar, SummaryBar, FileTabBar)
- **Page**: `*Page` (LoginPage)
- **Dialog**: `*Dialog` (AttachDialog, CreateSessionDialog, KillConfirmDialog)
- **View**: domain-named (Dashboard, Terminal, FileViewer, FileBrowser)

---

## 6. Implementation Protocol

### Pass Order

**First pass** — layout only:
- Page structure, flex/grid containers
- Width, height, min/max constraints
- Spacing, alignment, overflow behavior
- Typography scale (text-xs, text-sm, etc.)
- NO colors, NO borders, NO icons, NO animations

**Second pass** — visual polish:
- Semantic color tokens
- Borders, radius, separators
- Icons, badges, status indicators
- Interactive states (hover, focus, active, disabled)

**Third pass** — motion & states:
- Transitions, animations
- Loading states (Skeleton)
- Empty states (meaningful copy)
- Error states (toast + inline message)

### Rules

1. **Layout before Components** — 先确定空间结构，再选择组件
2. **Tokens over Ad-hoc** — 只用 Design Tokens 中定义的值，不允许随意 `w-[17px]`
3. **Composition over Decoration** — 先用 spacing/alignment/typography 解决问题，最后加装饰
4. **Render before Claim** — 必须 Playwright 渲染验证后，才能声称完成
5. **One accent only** — 只用 `primary` 一种强调色

---

## 7. Anti-Patterns (from codebase audit)

### Immediate fix (P1)

| Anti-pattern | Count | Fix |
|-------------|-------|-----|
| `space-y-*` / `space-x-*` | 20 uses | Replace with `flex flex-col gap-*` or `flex gap-*` |
| `text-[10px]` and `text-[11px]` | 49 uses | Standardize: metadata → `text-xs` (12px). If truly smaller is needed, define a `text-2xs` token |
| `min-h-11` (44px, non-standard) | 6 uses | This is mobile touch target. Standardize as `h-11` or use `min-h-[44px]` with a comment |
| `w-72` (288px dropdown) | 4 uses | Use `w-80` (320px) |
| Icons missing `data-icon` | 7+ places | Add `data-icon` to all Button icons |

### Cleanup (P2)

| Issue | Detail |
|-------|--------|
| Fixed column widths | `w-[72px]`, `w-[124px]`, `w-[100px]`, `w-[160px]`, `w-[200px]` — hard-coded pixel values that won't scale with font size |
| `dvh`/`vh` mix | `100dvh`, `85dvh`, `30vh` used inconsistently. Prefer `dvh` for mobile |
| Icon-size syntax | Older files use `h-3 w-3`, newer use `size-3`. Migrate to `size-*` |
| `max-h-[35vh]`, `h-[3.25rem]`, `h-[30vh]` | Use design tokens or Tailwind scale values |

### Consistent patterns (preserve)

These are deliberate and should be maintained:

| Pattern | Detail |
|---------|--------|
| App shell | Every page: `h-[100dvh] flex flex-col bg-background` |
| Content column | `flex-1 min-h-0 flex flex-col` — universal scroll-safe region |
| Mobile touch targets | `min-h-11 md:min-h-7` — 44px mobile, 28px desktop |
| Dialog scroll guard | `max-h-[90vh] overflow-y-auto` on DialogContent |
| Safe-area | `pb-[env(safe-area-inset-bottom)]` on bottom bars |
| Status dots | `w-2 h-2 rounded-full` green/emerald/gray tri-state |
| Dirty indicator | `bg-amber-500` dot — `size-1.5` or `w-2 h-2` |
| TabsContent override | `className="mt-0"` — neutralizes Tabs default margin |

---

## 8. Quality Gates

Before merging any UI PR:

- [ ] Layout model documented (or unchanged from this spec)
- [ ] Design tokens followed (no ad-hoc values)
- [ ] Responsive: desktop + mobile rendered via Playwright
- [ ] Visual critique checklist passed (alignment, proportion, spacing, hierarchy)
- [ ] No `space-y-*` or `space-x-*` in new code
- [ ] All icons have `data-icon` attribute
- [ ] TypeScript: 0 errors
- [ ] ESLint: 0 warnings
- [ ] Vitest: all pass
- [ ] Build: success

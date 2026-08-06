# Nession shadcn/ui Component Inventory

Last updated: 2026-08-06 (post-standardization refactor)

## Installed Primitives (21)

Generated via `npx shadcn@latest add`, version-controlled in `web/src/components/ui/`.

| Component | File | Radix Dependency | Notes |
|-----------|------|-----------------|-------|
| AlertDialog | `ui/alert-dialog.tsx` | `@radix-ui/react-alert-dialog` | Destructive confirmations |
| Badge | `ui/badge.tsx` | (none) | Status indicators |
| Button | `ui/button.tsx` | `@radix-ui/react-slot` | 7 variants (default/destructive/outline/secondary/ghost/link/icon) |
| Card | `ui/card.tsx` | (none) | Card/Header/Title/Description/Content/Footer |
| Checkbox | `ui/checkbox.tsx` | `@radix-ui/react-checkbox` | Form checkbox |
| Collapsible | `ui/collapsible.tsx` | `@radix-ui/react-collapsible` | Expand/collapse sections |
| ContextMenu | `ui/context-menu.tsx` | `@radix-ui/react-context-menu` | Right-click menus (FileBrowser) |
| Dialog | `ui/dialog.tsx` | `@radix-ui/react-dialog` | Modal dialogs |
| DropdownMenu | `ui/dropdown-menu.tsx` | (Base UI) | Dropdown menus (SessionDropdown) |
| Input | `ui/input.tsx` | (none) | Text input |
| Label | `ui/label.tsx` | `@radix-ui/react-label` | Form labels |
| ScrollArea | `ui/scroll-area.tsx` | `@radix-ui/react-scroll-area` | Scrollable containers |
| Select | `ui/select.tsx` | `@radix-ui/react-select` | Dropdown select (AddressSelector) |
| Separator | `ui/separator.tsx` | `@radix-ui/react-separator` | Horizontal/vertical dividers |
| Sheet | `ui/sheet.tsx` | `@radix-ui/react-dialog` | Slide-over panels (AgentDetailPanel) |
| Skeleton | `ui/skeleton.tsx` | (none) | Loading placeholders |
| Sonner | `ui/sonner.tsx` | `sonner` | Toast notifications |
| Tabs | `ui/tabs.tsx` | `@base-ui/react` | Tab strips (BottomBar, BottomSheet, AgentDetailPanel) |
| Textarea | `ui/textarea.tsx` | (none) | Multi-line text input (InputPanel) |
| Tooltip | `ui/tooltip.tsx` | `@base-ui/react` | Icon button hints (~20 sites) |
| Resizable | `ui/resizable.tsx` | `react-resizable-panels` | Drag-resize panels (SidePanel + FileTabs) |

## Custom UI Wrappers (2)

Thin domain wrappers over shadcn primitives. This is the intended shadcn composition pattern.

| Component | File | Wraps | Purpose |
|-----------|------|-------|---------|
| ConnectionStatusBadge | `ui/ConnectionStatusBadge.tsx` | Badge | Colored pulse dot + status text (disconnected/connecting/connected/authenticated) |
| RefreshButton | `ui/RefreshButton.tsx` | Button | Icon-only refresh with loading spinner animation |

## Custom Components → shadcn Mapping

Each custom component in `web/src/components/` is audited against available shadcn primitives.

### ✅ Correctly Composed (no changes needed)

| Component | shadcn Used | Notes |
|-----------|------------|-------|
| LoginPage | Card, Button, Input, Label, Checkbox, ConnectionStatusBadge | Full shadcn composition |
| DashboardHeader | Button, ConnectionStatusBadge, RefreshButton | Full shadcn composition |
| SearchBar | Input, Button | Filter group could use ToggleGroup if installed |
| AgentCard | Card, Badge, Button, Input | Full shadcn composition |
| SessionList | Button, ScrollArea, Skeleton | Could use Table if data gets denser |
| SessionPanel | Button, Input, Badge, ScrollArea, Skeleton | Full shadcn composition |
| SessionDropdown | DropdownMenu, Input, ScrollArea, Skeleton, Button | Correct; could enhance with Command |
| CreateSessionDialog | Dialog, Button, Input, Label, Select | Full shadcn composition |
| KillConfirmDialog | Dialog, Button | Should standardize destructive confirms on AlertDialog |
| AddressSelector | Select | Full shadcn composition |
| FileBrowser | Button, Input, Skeleton, ContextMenu, AlertDialog | Best example of shadcn composition in codebase |
| InputPanel | Button, Textarea | Domain-specific terminal input |
| QuickCommandsPanel | Button, Input, Badge, Separator | Domain-specific escape-sequence builder |
| Terminal / TerminalLayout / MobileTerminalLayout | (composition only) | Orchestration layers, no direct shadcn usage needed |

### ⚠️ Partially Using shadcn

| Component | shadcn Used | Issue | Recommendation |
|-----------|------------|-------|----------------|
| AgentDetailPanel | Sheet, Card, Badge, Button, Separator | Internal `TabBar` duplicates hand-rolled tab pattern | Install shadcn Tabs |
| BottomSheet | Button | Tab strip is hand-rolled `<button>`s with `border-b-2` styling | Install shadcn Tabs |

### ❌ Not Using shadcn (Reimplementing Primitives)

| Component | Issue | Lines Affected | Recommendation |
|-----------|-------|---------------|----------------|
| BottomBar | Full tab strip reimplementation using only `cn()` | ~20 lines (tab buttons) | Install shadcn Tabs |
| FileTabs | Custom `TabBar` with dirty indicators and close buttons | ~30 lines (TabBar component) | Domain-specific; could use Tabs as base |
| SidePanel | Raw `mousemove`/`mouseup` listeners for drag-resize; custom mobile overlay | ~30 lines (resize logic) | Install shadcn Resizable + use Sheet for mobile |

## shadcn Components NOT Installed — Priority Queue

Install via `npx shadcn@latest add <name> --yes` from `web/`. Components land in `web/src/components/ui/`.

### 🔴 High Priority (replace hand-rolled implementations)

| Component | Sites Affected | Radix/Peer Dependency | Install Command |
|-----------|---------------|----------------------|-----------------|
| **Tabs** | BottomSheet, BottomBar, AgentDetailPanel TabBar, FileTabs TabBar, SearchBar filter group (5 sites) | `@radix-ui/react-tabs` | `npx shadcn@latest add tabs` |
| **Resizable** | SidePanel drag-resize (~30 lines raw DOM) | `react-resizable-panels` | `npx shadcn@latest add resizable` |

### 🟡 Medium Priority (enhance existing UX)

| Component | Sites Affected | Radix/Peer Dependency |
|-----------|---------------|----------------------|
| **Tooltip** | ~20 icon-only buttons across the app | `@radix-ui/react-tooltip` |
| **Command** | SessionDropdown search/filter | `cmdk` |
| **Popover** | Info popovers, mini-menus | `@radix-ui/react-popover` |

### 🟢 Low Priority (nice to have)

| Component | Sites Affected | Radix/Peer Dependency |
|-----------|---------------|----------------------|
| Toggle / ToggleGroup | SearchBar filter buttons | `@radix-ui/react-toggle` |
| Table | FileBrowser rows, SessionList columns | (none) |
| Breadcrumb | FileBrowser crumb trail | (none) |
| Avatar | Agent icons | `@radix-ui/react-avatar` |
| Accordion | AgentDetailPanel sections | `@radix-ui/react-accordion` |
| Progress | Operation feedback | `@radix-ui/react-progress` |
| HoverCard | Agent/session quick preview | `@radix-ui/react-hover-card` |

## Golden Rules

1. **Always check this inventory before building a new UI pattern** — shadcn likely has a primitive for it
2. **Install via CLI only** — `npx shadcn@latest add <name> --yes`, never hand-write shadcn components
3. **Custom wrappers are the intended pattern** — thin domain wrappers over shadcn primitives (like ConnectionStatusBadge, RefreshButton)
4. **Before hand-rolling any layout pattern** (tabs, resize, tooltip), check the "NOT installed" list above
5. **Destructive confirmation dialogs → AlertDialog**, not Dialog (matching FileBrowser's delete pattern)
6. **New component files go in `web/src/components/`**, not `ui/`. Only shadcn-generated primitives live in `ui/`.

## Cross-References

- **CLAUDE.md** — Frontend Conventions, Key Design Decisions (section 1)
- **nession-development SKILL.md** — "shadcn/ui Component Conventions" section
- **nession-env SKILL.md** — Troubleshooting: "shadcn cn import fails"
- **shadcn docs** — https://ui.shadcn.com/docs/components

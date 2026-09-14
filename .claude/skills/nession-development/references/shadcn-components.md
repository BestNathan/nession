# Nession shadcn/ui Component Inventory

Last verified against `web/src/components/ui/` on 2026-09-14.

**The primitives are built on `@base-ui/react`, not Radix.** 18 of the files
import from it; the single exception is `alert-dialog.tsx`, which uses
`@radix-ui/react-alert-dialog`. `@radix-ui/react-alert-dialog` is the only
Radix package in `package.json` — an older revision of this document listed a
Radix package per component, and none of those were ever installed.

## Installed Primitives (25)

Generated via `npx shadcn@latest add`, version-controlled in
`web/src/components/ui/`. **In use** is how many files import it (excluding
tests).

| Component | File | Base | In use |
|-----------|------|------|--------|
| AlertDialog | `ui/alert-dialog.tsx` | `@radix-ui/react-alert-dialog` | 4 |
| Badge | `ui/badge.tsx` | `@base-ui/react/merge-props` | 3 |
| Button | `ui/button.tsx` | `@base-ui/react/button` | 27 |
| Card | `ui/card.tsx` | (none) | 1 |
| Checkbox | `ui/checkbox.tsx` | `@base-ui/react/checkbox` | 1 |
| Collapsible | `ui/collapsible.tsx` | `@base-ui/react/collapsible` | 1 |
| ContextMenu | `ui/context-menu.tsx` | `@base-ui/react/context-menu` | 4 |
| Dialog | `ui/dialog.tsx` | `@base-ui/react/dialog` | 5 |
| DropdownMenu | `ui/dropdown-menu.tsx` | `@base-ui/react/menu` | 2 |
| Input | `ui/input.tsx` | `@base-ui/react/input` | 11 |
| Label | `ui/label.tsx` | (none) | 6 |
| Popover | `ui/popover.tsx` | `@base-ui/react/popover` | 2 |
| Progress | `ui/progress.tsx` | `@base-ui/react/progress` | 1 |
| ScrollArea | `ui/scroll-area.tsx` | `@base-ui/react/scroll-area` | 4 |
| Select | `ui/select.tsx` | `@base-ui/react/select` | 3 |
| Separator | `ui/separator.tsx` | `@base-ui/react/separator` | 2 |
| Skeleton | `ui/skeleton.tsx` | (none) | 3 |
| Tabs | `ui/tabs.tsx` | `@base-ui/react/tabs` | 2 |
| Textarea | `ui/textarea.tsx` | (none) | 1 |
| ToggleGroup | `ui/toggle-group.tsx` | `@base-ui/react/toggle` | 1 |
| Tooltip | `ui/tooltip.tsx` | `@base-ui/react/tooltip` | 5 |

Installed but **currently unused** — nothing imports them. They are not load-
bearing; treat them as candidates for removal rather than as available
building blocks:

| Component | File | Base | Notes |
|-----------|------|------|-------|
| Resizable | `ui/resizable.tsx` | `react-resizable-panels` | its consumer, `SidePanel`, was deleted with the Dashboard (#655) |
| Sheet | `ui/sheet.tsx` | `@base-ui/react/dialog` | its consumers, `AgentDetailPanel` / mobile overlays, are gone |
| Sonner | `ui/sonner.tsx` | `sonner` | `main.tsx` imports `Toaster` from the `sonner` package directly, bypassing this wrapper |
| Toggle | `ui/toggle.tsx` | `@base-ui/react/toggle` | only `toggle-group` remains in use; `toggle-variants.ts` is shared by both |

`Button` has **6 variants** (`default` / `outline` / `secondary` / `ghost` /
`destructive` / `link`) and sizes `xs` / `sm` / `default` / `lg` / `icon` —
`icon` is a *size*, not a variant.

## Custom UI Wrappers (2)

Thin domain wrappers over shadcn primitives. This is the intended shadcn
composition pattern.

| Component | File | Wraps | Purpose |
|-----------|------|-------|---------|
| ConnectionStatusBadge | `ui/ConnectionStatusBadge.tsx` | Badge | Colored pulse dot + status text |
| RefreshButton | `ui/RefreshButton.tsx` | Button | Icon-only refresh with loading spinner |

## Where feature UI lives

`web/src/components/` contains **only** `ui/`. Feature UI lives in
`features/<feature>/components/`; shell UI lives in `app/` (enforced by
`nession/no-reverse-imports`; see `docs/architecture/web.md`). Only
shadcn-generated primitives and the two wrappers above belong in `ui/`.

## Not Installed

Verified absent from `web/src/components/ui/`, ordered by how likely a feature
is to want one. Install via `npx shadcn@latest add <name> --yes` from `web/`.

| Component | Would serve | Peer dependency |
|-----------|-------------|-----------------|
| Command | session/agent search & filtering | `cmdk` |
| Table | dense file-browser rows, session columns | (none) |
| Breadcrumb | file-browser crumb trail | (none) |
| Avatar | agent identity | (none) |
| Accordion | collapsible detail sections | (none) |
| HoverCard | session/agent quick preview | (none) |

## Golden Rules

1. **Check this inventory before building a new UI pattern** — shadcn likely has a primitive for it
2. **Install via CLI only** — `npx shadcn@latest add <name> --yes`, never hand-write shadcn components
3. **Custom wrappers are the intended pattern** — thin domain wrappers over primitives (like ConnectionStatusBadge, RefreshButton)
4. **Before hand-rolling a layout pattern, check the "Not Installed" list** — and prefer composing an existing primitive over a bespoke one
5. **Destructive confirmation dialogs → AlertDialog**, not Dialog
6. **Only shadcn-generated primitives (and the two wrappers) live in `ui/`** — no `index.ts` barrel. Feature UI goes in `features/<feature>/components/`, shell UI in `app/`

## Cross-References

- **CLAUDE.md** — Frontend Conventions, Key Design Decisions (section 1)
- **web/CLAUDE.md** — "UI kit" and the layout-of-code table
- **docs/architecture/web.md** — layer model and import direction
- **nession-env SKILL.md** — Troubleshooting: "shadcn cn import fails"
- **shadcn docs** — https://ui.shadcn.com/docs/components

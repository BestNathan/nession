# Nession shadcn/ui Component Inventory

This file is a **human navigation reference**, not the canonical usage report.

For current production consumer counts and removal candidates, run:

```bash
just design-inventory
# or, for machine-readable detail:
just design-inventory-json
```

The executable inventory is maintained by `design/scripts/audit-design-system.mjs` and is the authoritative evidence for #760-style coverage questions. This avoids the usage counts in this reference becoming stale after every UI change.

Last structure verification: **2026-09-17**, against `staging` / #760 implementation.

## Installed generic primitives

The current `web/src/components/ui/` tree contains these 21 shadcn-style generic primitives:

| Component | File | Primary base |
|---|---|---|
| AlertDialog | `ui/alert-dialog.tsx` | `@radix-ui/react-alert-dialog` |
| Badge | `ui/badge.tsx` | `@base-ui/react/merge-props` |
| Button | `ui/button.tsx` | `@base-ui/react/button` |
| Card | `ui/card.tsx` | none |
| Checkbox | `ui/checkbox.tsx` | `@base-ui/react/checkbox` |
| Collapsible | `ui/collapsible.tsx` | `@base-ui/react/collapsible` |
| ContextMenu | `ui/context-menu.tsx` | `@base-ui/react/context-menu` |
| Dialog | `ui/dialog.tsx` | `@base-ui/react/dialog` |
| DropdownMenu | `ui/dropdown-menu.tsx` | `@base-ui/react/menu` |
| Input | `ui/input.tsx` | `@base-ui/react/input` |
| Label | `ui/label.tsx` | none |
| Popover | `ui/popover.tsx` | `@base-ui/react/popover` |
| Progress | `ui/progress.tsx` | `@base-ui/react/progress` |
| ScrollArea | `ui/scroll-area.tsx` | `@base-ui/react/scroll-area` |
| Select | `ui/select.tsx` | `@base-ui/react/select` |
| Separator | `ui/separator.tsx` | `@base-ui/react/separator` |
| Skeleton | `ui/skeleton.tsx` | none |
| Tabs | `ui/tabs.tsx` | `@base-ui/react/tabs` |
| Textarea | `ui/textarea.tsx` | none |
| ToggleGroup | `ui/toggle-group.tsx` | `@base-ui/react/toggle` |
| Tooltip | `ui/tooltip.tsx` | `@base-ui/react/tooltip` |

Most interactive primitives are built on `@base-ui/react`; `AlertDialog` is the explicit Radix exception.

`Button` currently exposes variants `default` / `outline` / `secondary` / `ghost` / `destructive` / `link` and sizes `xs` / `sm` / `default` / `lg` / `icon`. `icon` is a size, not a variant.

## Wrappers / adapters

`components/ui` also contains two PascalCase wrappers:

| Component | File | Wraps | Boundary note |
|---|---|---|---|
| ConnectionStatusBadge | `ui/ConnectionStatusBadge.tsx` | Badge | Currently imports socket connection state. Keep under review: if it grows product-presence or Session/Workspace policy, move that semantics upward into a pattern/feature. |
| RefreshButton | `ui/RefreshButton.tsx` | Button + Tooltip | Generic refresh interaction; keep visual geometry normalized through the design system. |

A wrapper is allowed to adapt a primitive. It must not become an excuse to put Nession product hierarchy or capability-presence policy in `components/ui`.

## Stale inventory lesson

The previous 2026-09-14 version of this document listed four installed-but-unused primitives:

```text
Resizable
Sheet
Sonner
Toggle
```

Those files are now absent from `web/src/components/ui/`. The #760 executable audit sees **23 `.tsx` UI files total (21 generic primitives + 2 wrappers) and zero installed-unused `.tsx` components** at the current snapshot.

That change is exactly why consumer counts/removal status must be computed instead of maintained manually here.

## Not installed

These remain examples of upstream primitives that may be useful later. Their absence is not a requirement to install them:

| Component | Possible use |
|---|---|
| Command | search / filtering |
| Table | dense tabular rows |
| Breadcrumb | path navigation |
| Avatar | identity display |
| Accordion | collapsible detail sections |
| HoverCard | contextual preview |

When a task needs one, follow `nession-web-design` rather than adding it preemptively.

## Rules

1. **Reuse before adding.** Check the current tree and executable inventory first.
2. **Install through shadcn CLI only:** `cd web && npx shadcn@latest add <name> --yes`.
3. **Adding is only the import step.** Normalize generated code to Nession Semantic/Experience vocabulary before treating it as integrated.
4. **Keep primitives generic.** Session / Workspace / Agent / Terminal / capability semantics belong in patterns/features, not a primitive API.
5. **Destructive confirmation uses AlertDialog**, not a generic Dialog.
6. **Do not hand-maintain consumer counts here.** Use `just design-inventory` / `just design-inventory-json`.

## Cross-references

- `.claude/skills/nession-web-design/SKILL.md` — design-system consumption/extension workflow
- `docs/design/design-system/inventory.md` — audit conclusions and coverage model
- `docs/design/design-system/components.md` — primitive/pattern ownership boundary
- `docs/architecture/web.md` — Web layer model and import direction

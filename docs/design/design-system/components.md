# Components (primitives)

Primitive components stay generic. Nession product identity lives in [patterns](patterns.md) and interaction models, not in a custom button kit.

```text
Button
Input
Tabs
Toggle
List
Menu
Sheet
Dialog
Status
```

This list is illustrative, not an install inventory. Web continues to prefer shadcn/ui primitives (see the Nession development skill inventory). App uses the corresponding native primitives.

## Rules

- Primitives have no Session / Agent / Terminal domain knowledge.
- Primitives consume Semantic (and platform Experience) tokens, never Primitive palette tokens directly ([tokens.md](tokens.md)).
- If a control needs domain behavior (connection status, session row, surface switch), it is a **pattern**, not a new primitive.

Do not fork Button, Input, or Tabs into Nession-branded variants in order to express product identity. Express identity in [SessionList](patterns/session-list.md), [SurfaceSwitcher](patterns/surface-switcher.md), [WorkspaceNavigation](patterns/workspace-navigation.md), and related [patterns](patterns.md).

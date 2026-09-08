# Explorer Extension API

The Explorer is an extensible file-tree framework. Extensions register decoration
providers, context-menu contributions, and other hooks on a **per-Explorer
registry**.

## Lifecycle and scoping

Every `Explorer` mount owns one `ExplorerRegistry` instance (`useState`), so
extensions are scoped to one tree instance and can never leak across sessions,
workspaces or test cases. The registry dies with the mount; there is no module
global and nothing to reset between tests. `Explorer` registers the built-in
core extension plus the `extensions` prop on mount and unregisters them on
unmount or when the prop changes.

A register/unregister bumps the registry version and notifies subscribers.
`Explorer` subscribes via `useSyncExternalStore`, so replacing `extensions`
(prop identity) — or a future store-driven provider re-registering — re-resolves
decorations and context menus **incrementally, without remounting the tree**.

## Quick start

Pass extensions through `Explorer` props; lifetime is managed by `Explorer`:

```tsx
import {
  Explorer,
  type ExplorerExtension,
  type ExplorerDecorationProvider,
} from '@/features/explorer';

const gitDecorationProvider: ExplorerDecorationProvider = {
  provide(node) {
    if (node.kind !== 'file') return undefined;
    // Future: query git status for node.uri
    const status = getGitStatus(node.uri);
    if (status === 'modified') {
      return { badge: 'M', tooltip: 'Modified', className: 'text-amber-500' };
    }
    if (status === 'untracked') {
      return { badge: 'U', tooltip: 'Untracked', className: 'text-green-500' };
    }
    return undefined;
  },
};

const gitExtension: ExplorerExtension = {
  id: 'git-decorations',
  decorations: [gitDecorationProvider],
};

// <Explorer provider={...} extensions={[gitExtension]} ... />
```

For programmatic registration (e.g. an effect reacting to a store), construct
or receive an `ExplorerRegistry` instance directly — it is plain TypeScript,
framework-free:

```ts
import { ExplorerRegistry, type ExplorerExtension } from '@/features/explorer';

const registry = new ExplorerRegistry();
registry.register(gitExtension); // throws on duplicate id
registry.unregister(gitExtension.id);
const unsubscribe = registry.subscribe(() => { /* re-resolve */ });
```

## Extension shape

```ts
interface ExplorerExtension {
  id: string;
  decorations?: ExplorerDecorationProvider[];
  contextMenus?: ExplorerContextMenuContribution[];
  actions?: ExplorerActionProvider[];
  commands?: ExplorerCommand[];
  nodeRenderer?: ExplorerNodeRendererContribution;
}
```

### Decorations

`ExplorerDecorationProvider.provide(node)` returns optional visual overlays:

| Field       | Purpose                          |
|-------------|----------------------------------|
| `badge`     | Short label (e.g. git status)    |
| `tooltip`   | Hover text                       |
| `className` | Tailwind classes on the row      |
| `icon`      | React node beside the name       |
| `priority`  | Higher wins when merging         |

Multiple providers merge via `resolveDecorations`; see
`decorations/resolveDecorations.ts`.

### Context menus

```ts
interface ExplorerContextMenuContribution {
  id: string;
  when?: (node: ExplorerNode) => boolean;
  render: (node, ctx) => ReactNode;
}
```

Render shadcn `ContextMenuItem` nodes. Optional `when` filters by node.

## Core extension

Built-in rename/delete/copy actions live in `createCoreExplorerExtension()`.
`Explorer` always registers core plus any `extensions` prop on its own
registry instance, and unregisters both on unmount.

## Testing

Unit tests construct `new ExplorerRegistry()` per test — no global reset
needed. See `testing/mockExtension.tsx` for a minimal decoration + context-menu
example.

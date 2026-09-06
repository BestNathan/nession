# Explorer Extension API

The Explorer is an extensible file-tree framework. Extensions register decoration
providers, context-menu contributions, and other hooks via a central registry.

## Quick start

Pass extensions through `Explorer` props, or call `registerExtension` directly
(lifetime is managed by `Explorer` when using props):

```tsx
import {
  Explorer,
  registerExtension,
  type ExplorerExtension,
  type ExplorerDecorationProvider,
} from '@/explorer';

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

registerExtension(gitExtension);
// Prefer props when mounting Explorer:
// <Explorer extensions={[gitExtension]} ... />
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
`Explorer` always registers core plus any `extensions` prop, and unregisters on
unmount.

## Testing

Use `resetExplorerRegistry()` in unit tests. See `testing/mockExtension.tsx`
for a minimal decoration + context-menu example.

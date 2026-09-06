import { ContextMenuItem } from '@/components/ui/context-menu';

import type { ExplorerExtension } from '../commands/types';

export const mockExplorerExtension: ExplorerExtension = {
  id: 'mock-test-extension',
  decorations: [
    {
      provide(node) {
        if (node.name.startsWith('test-')) {
          return { badge: 'MOCK' };
        }
        return undefined;
      },
    },
  ],
  contextMenus: [
    {
      id: 'mock-action',
      when: (node) => node.kind === 'file',
      render: () => (
        <ContextMenuItem onClick={() => undefined}>Mock action</ContextMenuItem>
      ),
    },
  ],
};

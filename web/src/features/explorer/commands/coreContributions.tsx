import { Copy, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { copyToClipboard } from '@/lib/clipboard';

import type { ExplorerExtension } from './types';

function copyPath(text: string, label: string): void {
  copyToClipboard(text).then(
    () => {
      toast.success(`${label} copied`);
    },
    () => {
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    },
  );
}

export function createCoreExplorerExtension(): ExplorerExtension {
  return {
    id: 'core',
    contextMenus: [
      {
        id: 'core.copy-path',
        render: (node) => (
          <ContextMenuItem onClick={() => copyPath(node.uri, 'Path')}>
            <Copy /> Copy path
          </ContextMenuItem>
        ),
      },
      {
        id: 'core.copy-full-path',
        when: (node) => node.metadata?.fullPath !== undefined,
        render: (node) => (
          <ContextMenuItem
            onClick={() => copyPath(node.metadata!.fullPath!, 'Full path')}
          >
            <Copy /> Copy full path
          </ContextMenuItem>
        ),
      },
      {
        id: 'core.rename',
        when: (node) => node.capabilities.rename === true,
        render: (node, ctx) => (
          <ContextMenuItem onClick={() => ctx.onRename?.(node)}>
            <Pencil /> Rename
          </ContextMenuItem>
        ),
      },
      {
        id: 'core.separator-before-delete',
        when: (node) => node.capabilities.delete === true,
        render: () => <ContextMenuSeparator />,
      },
      {
        id: 'core.delete',
        when: (node) => node.capabilities.delete === true,
        render: (node, ctx) => (
          <ContextMenuItem
            variant="destructive"
            onClick={() => ctx.onDelete?.(node)}
          >
            <Trash2 /> Delete
          </ContextMenuItem>
        ),
      },
    ],
  };
}

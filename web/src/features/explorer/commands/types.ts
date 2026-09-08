import type { ReactNode } from 'react';

import type { ExplorerDecorationProvider } from '../decorations/types';
import type { ExplorerNode } from '../types';

export interface ExplorerExtension {
  id: string;
  decorations?: ExplorerDecorationProvider[];
  contextMenus?: ExplorerContextMenuContribution[];
  actions?: ExplorerActionProvider[];
  commands?: ExplorerCommand[];
  nodeRenderer?: ExplorerNodeRendererContribution;
}

export interface ExplorerContextMenuContext {
  onRename?: (node: ExplorerNode) => void;
  onDelete?: (node: ExplorerNode) => void;
}

export interface ExplorerContextMenuContribution {
  id: string;
  when?: (node: ExplorerNode) => boolean;
  render: (node: ExplorerNode, ctx: ExplorerContextMenuContext) => ReactNode;
}

export interface ExplorerAction {
  id: string;
  label: string;
  execute: () => void;
}

export interface ExplorerActionProvider {
  provide(node: ExplorerNode): ExplorerAction[] | undefined;
}

export interface ExplorerCommand {
  id: string;
  label: string;
  execute: (node?: ExplorerNode) => void;
}

export interface ExplorerNodeRendererContribution {
  render?: (node: ExplorerNode, defaultRender: () => ReactNode) => ReactNode;
}

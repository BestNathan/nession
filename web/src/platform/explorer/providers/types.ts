import type { ExplorerNode } from '../types';

export interface ExplorerDataProvider {
  loadChildren(node: ExplorerNode | null): Promise<ExplorerNode[]>;
  create?(parent: ExplorerNode | null, kind: 'file' | 'directory', name: string): Promise<void>;
  rename?(node: ExplorerNode, name: string): Promise<void>;
  delete?(node: ExplorerNode): Promise<void>;
  move?(node: ExplorerNode, target: ExplorerNode): Promise<void>;
}

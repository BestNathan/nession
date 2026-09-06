import type { ReactNode } from 'react';

import type { ExplorerNode } from '../types';

export interface ExplorerDecoration {
  badge?: string;
  tooltip?: string;
  className?: string;
  icon?: ReactNode;
  priority?: number;
}

export interface ExplorerDecorationProvider {
  provide(node: ExplorerNode): ExplorerDecoration | undefined;
}

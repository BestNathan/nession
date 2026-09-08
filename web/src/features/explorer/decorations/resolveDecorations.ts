import type { ReactNode } from 'react';

import type { ExplorerNode } from '../types';

import type { ExplorerDecoration, ExplorerDecorationProvider } from './types';

export interface ResolvedDecorations {
  badge?: string;
  tooltip?: string;
  className?: string;
  icons: ReactNode[];
}

function decorationPriority(decoration: ExplorerDecoration): number {
  return decoration.priority ?? 0;
}

function pickHighestPriorityField(
  decorations: ExplorerDecoration[],
  field: 'badge' | 'tooltip' | 'className',
): string | undefined {
  const sorted = [...decorations].sort(
    (a, b) => decorationPriority(b) - decorationPriority(a),
  );

  for (const decoration of sorted) {
    const value = decoration[field];
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

export function resolveDecorations(
  node: ExplorerNode,
  providers: ExplorerDecorationProvider[],
): ResolvedDecorations {
  const decorations = providers
    .map((provider) => provider.provide(node))
    .filter((decoration): decoration is ExplorerDecoration => decoration !== undefined);

  if (decorations.length === 0) {
    return { icons: [] };
  }

  const icons = decorations.flatMap((decoration) =>
    decoration.icon !== undefined ? [decoration.icon] : [],
  );

  return {
    badge: pickHighestPriorityField(decorations, 'badge'),
    tooltip: pickHighestPriorityField(decorations, 'tooltip'),
    className: pickHighestPriorityField(decorations, 'className'),
    icons,
  };
}

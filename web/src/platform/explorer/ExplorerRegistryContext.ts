import { createContext } from 'react';

import type { ExplorerRegistry } from './registry';

/**
 * React context carrying the per-Explorer-mount extension registry down to
 * row renderers. Null when a row renders outside an Explorer provider.
 */
export const ExplorerRegistryContext = createContext<ExplorerRegistry | null>(null);

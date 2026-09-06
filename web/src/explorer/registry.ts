import type {
  ExplorerContextMenuContribution,
  ExplorerExtension,
} from './commands/types';
import type { ExplorerDecorationProvider } from './decorations/types';
import type { ExplorerNode } from './types';

const extensions: ExplorerExtension[] = [];

export function registerExtension(extension: ExplorerExtension): void {
  extensions.push(extension);
}

export function getExtensions(): readonly ExplorerExtension[] {
  return extensions;
}

export function getDecorationProviders(): ExplorerDecorationProvider[] {
  return extensions.flatMap((extension) => extension.decorations ?? []);
}

export function getContextMenuContributions(
  node: ExplorerNode,
): ExplorerContextMenuContribution[] {
  return extensions
    .flatMap((extension) => extension.contextMenus ?? [])
    .filter((contribution) => contribution.when === undefined || contribution.when(node));
}

/** Clears all registered extensions — for unit tests only. */
export function resetExplorerRegistry(): void {
  extensions.length = 0;
}

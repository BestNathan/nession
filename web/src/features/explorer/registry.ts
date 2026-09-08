import type {
  ExplorerContextMenuContribution,
  ExplorerExtension,
} from './commands/types';
import type { ExplorerDecorationProvider } from './decorations/types';
import type { ExplorerNode } from './types';

/**
 * Instance-scoped extension registry for one Explorer mount.
 *
 * The registry is created per Explorer instance (useState) and dies with it —
 * extensions never leak across trees, sessions or workspaces, so no global
 * reset is needed between tests. Register/unregister notify subscribers and
 * bump a monotonic version; Explorer subscribes via useSyncExternalStore so a
 * contribution change re-resolves decorations and context menus incrementally
 * without remounting the tree.
 */
export class ExplorerRegistry {
  private readonly extensions = new Map<string, ExplorerExtension>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** Registers an extension; throws when the id is already registered here. */
  register(extension: ExplorerExtension): void {
    if (this.extensions.has(extension.id)) {
      throw new Error(`Explorer extension '${extension.id}' is already registered`);
    }
    this.extensions.set(extension.id, extension);
    this.changed();
  }

  /** Removes an extension by id. No-op when the id is not registered. */
  unregister(id: string): void {
    if (this.extensions.delete(id)) {
      this.changed();
    }
  }

  getExtensions(): readonly ExplorerExtension[] {
    return [...this.extensions.values()];
  }

  getDecorationProviders(): ExplorerDecorationProvider[] {
    return [...this.extensions.values()].flatMap(
      (extension) => extension.decorations ?? [],
    );
  }

  getContextMenuContributions(
    node: ExplorerNode,
  ): ExplorerContextMenuContribution[] {
    return [...this.extensions.values()]
      .flatMap((extension) => extension.contextMenus ?? [])
      .filter((contribution) => contribution.when === undefined || contribution.when(node));
  }

  /**
   * Subscribes to register/unregister changes and returns an unsubscribe
   * function. Pairs with {@link getVersion} as a useSyncExternalStore snapshot.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Monotonic version bumped on every register/unregister. */
  getVersion(): number {
    return this.version;
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

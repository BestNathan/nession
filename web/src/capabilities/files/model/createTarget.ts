import type { ExplorerNode } from '@/platform/explorer';

export type CreateKind = 'file' | 'folder';

/**
 * The destination captured when a create/upload form opens.
 *
 * It is a snapshot, not a live expression: a later selection change must not
 * redirect an operation the user is already filling in.
 */
export interface CreateTarget {
  parentPath: string;
}

export interface CreateTargetContext {
  /** The Explorer's selected nodes (selection is independent of active/expanded). */
  selected?: readonly ExplorerNode[];
  /** The active/open node, used when nothing is selected. */
  active?: ExplorerNode | null;
  /** The directory the browser is showing. */
  currentPath: string;
  /** The right-clicked node, when the entry point is a context menu. */
  contextTarget?: ExplorerNode | null;
}

export function parentPathOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
}

/**
 * Resolve the destination for a creation/upload operation.
 *
 * Right-clicked directory -> itself; selected directory -> itself; selected
 * file -> its parent; no selection -> the current browse directory. A
 * right-clicked file also resolves to its parent, which is the only
 * meaningful place to create beside it.
 */
export function resolveCreateTarget(context: CreateTargetContext): CreateTarget {
  const explicit = context.contextTarget;
  if (explicit) {
    return { parentPath: explicit.kind === 'directory' ? explicit.uri : parentPathOf(explicit.uri) };
  }

  const selected = context.selected?.[0];
  if (selected) {
    return { parentPath: selected.kind === 'directory' ? selected.uri : parentPathOf(selected.uri) };
  }

  if (context.active) {
    return {
      parentPath:
        context.active.kind === 'directory' ? context.active.uri : parentPathOf(context.active.uri),
    };
  }

  return { parentPath: context.currentPath };
}

export function joinPath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath}/${name}` : name;
}

/** Validate a single path segment. Returns a user-facing problem, or null. */
export function validateEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Enter a name.';
  }
  if (trimmed === '.' || trimmed === '..') {
    return 'Use a different name.';
  }
  if (/[/\\]/.test(trimmed)) {
    return 'Names cannot contain / or \\';
  }
  if ([...trimmed].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  })) {
    return 'Names cannot contain control characters.';
  }
  if (trimmed.length > 255) {
    return 'Names must be 255 characters or fewer.';
  }
  return null;
}

import type { ExplorerFlatNode } from '../ExplorerStore';
import type { ExplorerNode } from '../types';

export type ArboristNode = {
  id: string;
  name: string;
  children?: ArboristNode[];
};

export const EXPLORER_ROW_HEIGHT = 24;
export const DEFAULT_TREE_HEIGHT = 360;

function readAncestorInlineHeight(el: HTMLElement): number | null {
  let current: HTMLElement | null = el;
  while (current) {
    const inlineHeight = current.style.height;
    if (inlineHeight.endsWith('px')) {
      const parsed = Number.parseFloat(inlineHeight);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    current = current.parentElement;
  }
  return null;
}

export function measureExplorerTreeHeight(container: HTMLElement): number | null {
  const directHeight = container.offsetHeight;
  if (directHeight > 0) {
    return directHeight;
  }

  const toolbarHeight =
    container.previousElementSibling instanceof HTMLElement
      ? container.previousElementSibling.offsetHeight
      : 0;

  let host: HTMLElement | null = container.parentElement;
  while (host && host.offsetHeight === 0) {
    host = host.parentElement;
  }

  if (host && host.offsetHeight > 0) {
    return Math.max(host.offsetHeight - toolbarHeight, EXPLORER_ROW_HEIGHT);
  }

  const inlineHeight = readAncestorInlineHeight(container);
  if (inlineHeight !== null) {
    return Math.max(inlineHeight - toolbarHeight, EXPLORER_ROW_HEIGHT);
  }

  return null;
}

export function flatDataToArboristTree(
  flatData: ExplorerFlatNode[],
  rootChildIds: readonly string[],
): ArboristNode[] {
  const byId = new Map(flatData.map((row) => [row.id, row]));

  const toNode = (row: ExplorerFlatNode): ArboristNode => {
    if (row.children === false) {
      return { id: row.id, name: row.name };
    }

    const childRows =
      row.children === true
        ? []
        : row.children
            .map((id) => byId.get(id))
            .filter((child): child is ExplorerFlatNode => child !== undefined)
            .map(toNode);

    return { id: row.id, name: row.name, children: childRows };
  };

  return rootChildIds
    .map((id) => byId.get(id))
    .filter((row): row is ExplorerFlatNode => row !== undefined)
    .map(toNode);
}

export function renamedNodeId(node: ExplorerNode, newName: string): string | undefined {
  if (node.parentId === undefined) {
    return newName;
  }
  return `${node.parentId}/${newName}`;
}

import type { ExplorerDataProvider } from './providers/types';
import type { ExplorerNode, LoadState, NodeId } from './types';

export const ROOT_ID = '' as const;

export type ExplorerFlatNode = {
  id: string;
  name: string;
  children: boolean | string[];
};

export type ExplorerEvent =
  | { type: 'create'; node: ExplorerNode; parentId: NodeId }
  | { type: 'modify'; node: ExplorerNode }
  | { type: 'delete'; nodeId: NodeId }
  | { type: 'rename'; nodeId: NodeId; name: string; newId?: NodeId };

export interface ExplorerStoreSnapshot {
  revision: number;
  flatData: ExplorerFlatNode[];
  expandedIds: ReadonlySet<NodeId>;
  selectedIds: ReadonlySet<NodeId>;
  activeId: NodeId | null;
}

export class ExplorerStore {
  private readonly nodesById = new Map<NodeId, ExplorerNode>();
  private readonly childrenById = new Map<NodeId, NodeId[]>();
  private readonly expandedIds = new Set<NodeId>();
  private readonly selectedIds = new Set<NodeId>();
  private readonly loadStateById = new Map<NodeId, LoadState>();
  private readonly loadGenerationById = new Map<NodeId, number>();
  private pendingLoadCount = 0;
  private eventSeq = 0;
  private readonly eventsSinceLoad: Array<{ seq: number; event: ExplorerEvent }> = [];
  private activeId: NodeId | null = null;
  private revision = 0;
  private cachedRevision = -1;
  private cachedSnapshot: ExplorerStoreSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly provider: ExplorerDataProvider) {}

  getSnapshot = (): ExplorerStoreSnapshot => {
    if (this.cachedSnapshot !== null && this.cachedRevision === this.revision) {
      return this.cachedSnapshot;
    }

    this.cachedSnapshot = {
      revision: this.revision,
      flatData: this.getFlatData(),
      expandedIds: this.expandedIds,
      selectedIds: this.selectedIds,
      activeId: this.activeId,
    };
    this.cachedRevision = this.revision;
    return this.cachedSnapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async ensureRootLoaded(): Promise<void> {
    if (this.loadStateById.get(ROOT_ID) === 'loaded') {
      return;
    }
    await this.loadChildren(ROOT_ID);
  }

  expand(nodeId: NodeId): void {
    this.expandedIds.add(nodeId);
    const node = nodeId === ROOT_ID ? null : this.nodesById.get(nodeId);
    if (nodeId === ROOT_ID || node?.kind === 'directory') {
      void this.loadChildren(nodeId);
    }
    this.emit();
  }

  collapse(nodeId: NodeId): void {
    this.expandedIds.delete(nodeId);
    this.emit();
  }

  getChildren(nodeId: NodeId): NodeId[] {
    return [...(this.childrenById.get(nodeId) ?? [])];
  }

  getNode(nodeId: NodeId): ExplorerNode | undefined {
    return this.nodesById.get(nodeId);
  }

  async refresh(nodeId: NodeId): Promise<void> {
    this.loadStateById.set(nodeId, 'idle');
    await this.loadChildren(nodeId, { force: true });
  }

  applyEvent(event: ExplorerEvent): void {
    // A load's response describes the provider at request time, not the
    // filesystem after this event. Keep the events that overlap in-flight
    // loads so a completing snapshot can replay them instead of undoing them.
    if (this.pendingLoadCount > 0) {
      this.eventSeq += 1;
      this.eventsSinceLoad.push({ seq: this.eventSeq, event });
    }
    this.applyEventMutation(event);
    this.emit();
  }

  private applyEventMutation(event: ExplorerEvent): void {
    switch (event.type) {
      case 'create':
        this.applyCreate(event.node, event.parentId);
        break;
      case 'modify':
        this.nodesById.set(event.node.id, event.node);
        break;
      case 'delete':
        this.removeNode(event.nodeId);
        break;
      case 'rename':
        this.applyRename(event.nodeId, event.name, event.newId);
        break;
    }
  }

  setSelection(ids: Iterable<NodeId>): void {
    this.selectedIds.clear();
    for (const id of ids) {
      this.selectedIds.add(id);
    }
    this.emit();
  }

  setActive(id: NodeId | null): void {
    this.activeId = id;
    this.emit();
  }

  getFlatData(): ExplorerFlatNode[] {
    const result: ExplorerFlatNode[] = [];
    for (const node of this.nodesById.values()) {
      result.push({
        id: node.id,
        name: node.name,
        children: this.flatChildrenFor(node),
      });
    }
    return result;
  }

  private flatChildrenFor(node: ExplorerNode): boolean | string[] {
    if (node.kind === 'file') {
      return false;
    }

    const parentId = node.id;
    const loadState = this.loadStateById.get(parentId) ?? 'idle';
    if (loadState === 'loaded') {
      return this.childrenById.get(parentId) ?? [];
    }

    return true;
  }

  private applyCreate(node: ExplorerNode, parentId: NodeId): void {
    this.nodesById.set(node.id, {
      ...node,
      parentId: parentId === ROOT_ID ? undefined : parentId,
    });
    const siblings = this.childrenById.get(parentId) ?? [];
    // Replay after a snapshot may re-deliver an event the provider already
    // included; a child must not appear twice.
    if (!siblings.includes(node.id)) {
      this.childrenById.set(parentId, [...siblings, node.id]);
    }
    this.loadStateById.set(parentId, 'loaded');
  }

  private applyRename(nodeId: NodeId, name: string, newId?: NodeId): void {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return;
    }

    if (newId && newId !== nodeId) {
      this.rekeyNode(nodeId, newId, { ...node, id: newId, uri: newId, name });
      return;
    }

    this.nodesById.set(nodeId, { ...node, name });
  }

  private rekeyNode(oldId: NodeId, newId: NodeId, node: ExplorerNode): void {
    this.invalidateLoad(oldId);
    this.invalidateLoad(newId);
    this.nodesById.delete(oldId);
    this.nodesById.set(newId, node);

    const parentId = node.parentId ?? ROOT_ID;
    const siblings = this.childrenById.get(parentId);
    if (siblings) {
      this.childrenById.set(
        parentId,
        siblings.map((id) => (id === oldId ? newId : id)),
      );
    }

    if (this.childrenById.has(oldId)) {
      this.childrenById.set(newId, this.childrenById.get(oldId)!);
      this.childrenById.delete(oldId);
    }

    if (this.expandedIds.has(oldId)) {
      this.expandedIds.delete(oldId);
      this.expandedIds.add(newId);
    }

    if (this.selectedIds.has(oldId)) {
      this.selectedIds.delete(oldId);
      this.selectedIds.add(newId);
    }

    if (this.loadStateById.has(oldId)) {
      const state = this.loadStateById.get(oldId)!;
      // invalidateLoad fenced the old id's request; a moved 'loading' state
      // would otherwise have no owner left to settle it.
      this.loadStateById.set(newId, state === 'loading'
        ? (this.childrenById.has(newId) ? 'loaded' : 'idle')
        : state);
      this.loadStateById.delete(oldId);
    }

    if (this.activeId === oldId) {
      this.activeId = newId;
    }
  }

  private removeNode(nodeId: NodeId): void {
    const node = this.nodesById.get(nodeId);
    if (!node) {
      return;
    }

    // A pending load for this node or its descendants describes a subtree
    // that no longer exists; its completion must never resurrect it.
    this.invalidateLoad(nodeId);
    for (const childId of this.childrenById.get(nodeId) ?? []) {
      this.removeNode(childId);
    }

    const parentId = node.parentId ?? ROOT_ID;
    const siblings = this.childrenById.get(parentId);
    if (siblings) {
      this.childrenById.set(
        parentId,
        siblings.filter((id) => id !== nodeId),
      );
    }

    this.nodesById.delete(nodeId);
    this.childrenById.delete(nodeId);
    this.expandedIds.delete(nodeId);
    this.selectedIds.delete(nodeId);
    this.loadStateById.delete(nodeId);
    if (this.activeId === nodeId) {
      this.activeId = null;
    }
  }

  private async loadChildren(nodeId: NodeId, options: { force?: boolean } = {}): Promise<void> {
    const currentState = this.loadStateById.get(nodeId) ?? 'idle';
    if (!options.force && (currentState === 'loading' || currentState === 'loaded')) {
      return;
    }

    const generation = (this.loadGenerationById.get(nodeId) ?? 0) + 1;
    this.loadGenerationById.set(nodeId, generation);
    const eventStart = this.eventSeq;
    this.pendingLoadCount += 1;
    this.loadStateById.set(nodeId, 'loading');
    this.emit();

    try {
      const parentNode = nodeId === ROOT_ID ? null : (this.nodesById.get(nodeId) ?? null);
      if (nodeId !== ROOT_ID && !parentNode) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      const children = await this.provider.loadChildren(parentNode);
      // Only the newest load for this directory, and only while the directory
      // still exists, may commit. An older success or failure must not alter
      // the tree, load state, selection or active node.
      if (!this.isCurrentLoad(nodeId, generation)) {
        return;
      }

      this.commitChildren(nodeId, children);
      this.loadStateById.set(nodeId, 'loaded');
      // Events that arrived while this request was in flight are later facts
      // than the response; replay them so the older snapshot cannot undo them.
      this.replayEventsAfter(eventStart);
      this.emit();
    } catch {
      if (this.isCurrentLoad(nodeId, generation)) {
        this.loadStateById.set(nodeId, 'error');
        this.emit();
      }
    } finally {
      this.pendingLoadCount -= 1;
      if (this.pendingLoadCount === 0) {
        this.eventsSinceLoad.length = 0;
      }
    }
  }

  private isCurrentLoad(nodeId: NodeId, generation: number): boolean {
    return this.loadGenerationById.get(nodeId) === generation
      && (nodeId === ROOT_ID || this.nodesById.has(nodeId));
  }

  private commitChildren(nodeId: NodeId, children: ExplorerNode[]): void {
    const childIds: NodeId[] = [];
    const nextChildIds = new Set<NodeId>();

    for (const child of children) {
      this.nodesById.set(child.id, {
        ...child,
        parentId: nodeId === ROOT_ID ? undefined : nodeId,
      });
      childIds.push(child.id);
      nextChildIds.add(child.id);
    }

    for (const staleChildId of this.childrenById.get(nodeId) ?? []) {
      if (!nextChildIds.has(staleChildId)) {
        this.removeNode(staleChildId);
      }
    }

    this.childrenById.set(nodeId, childIds);
  }

  private replayEventsAfter(seq: number): void {
    for (const entry of this.eventsSinceLoad) {
      if (entry.seq > seq) {
        this.applyEventMutation(entry.event);
      }
    }
  }

  private invalidateLoad(nodeId: NodeId): void {
    this.loadGenerationById.set(nodeId, (this.loadGenerationById.get(nodeId) ?? 0) + 1);
  }

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

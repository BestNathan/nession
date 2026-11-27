import { useCallback, useEffect, useState } from 'react';
import {
  workspaceApi,
  type AgentWorkspaceDescriptor,
} from '../WorkspacePlugin';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

export interface AgentWorkspacesState {
  workspaces: AgentWorkspaceDescriptor[];
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  busy: boolean;
  actionError: string | null;
  refresh: () => void;
  create: (name: string) => Promise<AgentWorkspaceDescriptor | null>;
  remove: (workspaceId: string) => Promise<boolean>;
  clearActionError: () => void;
}

/** A visible Sandbox list on the ordinary mutable-list cadence (#4602 §2). */
const WORKSPACES_POLICY: PullRefreshPolicy = {
  intervalMs: 30_000,
  minIntervalMs: 3_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

/**
 * The current Session Agent's managed Workspace inventory (#3407, #3408).
 *
 * Reads never synthesize a registry: an unavailable Agent shows the transport
 * error and an empty inventory stays empty. Create is idempotent by name on
 * the Agent; delete is refused there while a Workspace is attached.
 *
 * The read lifecycle belongs to the shared pull controller (#4602). Create and
 * remove keep their authoritative post-state projection and then owe one
 * targeted read, so a concurrent change elsewhere is not missed.
 */
export function useAgentWorkspaces(sessionId: string | null): AgentWorkspacesState {
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { refresh: pull, invalidate, status } = usePullRefresh<AgentWorkspaceDescriptor[]>({
    context: ['agent-workspaces', sessionId],
    active: sessionId !== null,
    enabled: sessionId !== null,
    pull: () => workspaceApi.list(sessionId as string),
    apply: setWorkspaces,
    policy: WORKSPACES_POLICY,
    label: 'agent-workspaces',
  });

  // A different Session is a different Agent's inventory: nothing about the
  // previous one may remain on screen.
  useEffect(() => {
    setWorkspaces([]);
  }, [sessionId]);

  const refresh = useCallback(() => {
    void pull('manual');
  }, [pull]);

  const create = useCallback(
    async (name: string): Promise<AgentWorkspaceDescriptor | null> => {
      if (sessionId === null) {
        return null;
      }
      setBusy(true);
      setActionError(null);
      try {
        const created = await workspaceApi.create(sessionId, name);
        setWorkspaces((current) => {
          const existing = current.findIndex(
            (workspace) => workspace.workspace_id === created.workspace_id,
          );
          if (existing === -1) {
            return [...current, created];
          }
          return current.map((workspace, index) =>
            index === existing ? created : workspace,
          );
        });
        invalidate('mutation');
        return created;
      } catch (failure: unknown) {
        setActionError(
          failure instanceof Error ? failure.message : 'Workspace creation was refused',
        );
        return null;
      } finally {
        setBusy(false);
      }
    },
    [sessionId, invalidate],
  );

  const remove = useCallback(
    async (workspaceId: string): Promise<boolean> => {
      if (sessionId === null) {
        return false;
      }
      setBusy(true);
      setActionError(null);
      try {
        await workspaceApi.remove(sessionId, workspaceId);
        setWorkspaces((current) =>
          current.filter((workspace) => workspace.workspace_id !== workspaceId),
        );
        invalidate('mutation');
        return true;
      } catch (failure: unknown) {
        setActionError(
          failure instanceof Error ? failure.message : 'Workspace deletion was refused',
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [sessionId, invalidate],
  );

  const clearActionError = useCallback(() => {
    setActionError(null);
  }, []);

  return {
    workspaces,
    loading: status.loading,
    refreshing: status.refreshing,
    stale: status.stale,
    error: status.error,
    busy,
    actionError,
    refresh,
    create,
    remove,
    clearActionError,
  };
}
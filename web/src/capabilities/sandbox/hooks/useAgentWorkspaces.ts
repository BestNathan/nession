import { useCallback, useEffect, useState } from 'react';
import {
  workspaceApi,
  type AgentWorkspaceDescriptor,
} from '../WorkspacePlugin';

export interface AgentWorkspacesState {
  workspaces: AgentWorkspaceDescriptor[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  actionError: string | null;
  refresh: () => void;
  create: (name: string) => Promise<AgentWorkspaceDescriptor | null>;
  remove: (workspaceId: string) => Promise<boolean>;
  clearActionError: () => void;
}

/**
 * The current Session Agent's managed Workspace inventory (#3407, #3408).
 *
 * Reads never synthesize a registry: an unavailable Agent shows the transport
 * error and an empty inventory stays empty. Create is idempotent by name on
 * the Agent; delete is refused there while a Workspace is attached.
 */
export function useAgentWorkspaces(sessionId: string | null): AgentWorkspacesState {
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceDescriptor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (sessionId === null) {
      setWorkspaces([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    workspaceApi
      .list(sessionId)
      .then((next) => {
        if (!cancelled) {
          setWorkspaces(next);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setWorkspaces([]);
          setError(
            failure instanceof Error
              ? failure.message
              : 'The Agent Workspace inventory is unavailable',
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  const refresh = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

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
    [sessionId],
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
    [sessionId],
  );

  const clearActionError = useCallback(() => {
    setActionError(null);
  }, []);

  return {
    workspaces,
    loading,
    error,
    busy,
    actionError,
    refresh,
    create,
    remove,
    clearActionError,
  };
}

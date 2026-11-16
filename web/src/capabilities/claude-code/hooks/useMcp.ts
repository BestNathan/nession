import { useCallback, useEffect, useRef, useState } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type {
  ClaudeCodeMcpConnectRequest,
  ClaudeCodeMcpConnectResponse,
  ClaudeCodeMcpDefinition,
  ClaudeCodeMcpEntry,
  ClaudeCodeMcpMutateRequest,
  ClaudeCodeMcpMutateResponse,
  ClaudeCodeMcpProbe,
  ClaudeCodeMcpScope,
  ClaudeCodeMcpServerResponse,
  ClaudeCodeMcpServersResponse,
} from '../types';

/**
 * The MCP tab's state (#3600).
 *
 * Two rules shape it:
 *
 * - **The Session is the generation.** Every answer is tagged with the
 *   Session/Agent it was requested for, and an answer that arrives after the
 *   Session changed is dropped rather than rendered. The Agent-side unit
 *   re-resolves the Session on every call, so the browser's only job is not to
 *   show a stale answer under a new name.
 * - **Opening the tab reads configuration only.** The inventory request never
 *   probes; `inspect` is the explicit, separate operation. A refusal to probe
 *   is a state the view shows, not an error that hides the entry.
 */

export type McpSelection = { name: string; scope: ClaudeCodeMcpScope };

type MutationInput = Omit<
  ClaudeCodeMcpMutateRequest,
  'agent_id' | 'session_id' | 'definition'
> & { definition?: ClaudeCodeMcpDefinition | null };

type ConnectInput = Omit<ClaudeCodeMcpConnectRequest, 'agent_id' | 'session_id'>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The Claude MCP operation failed';
}

function useInventory({
  agentId,
  sessionId,
  active,
  generation,
  reloadNonce,
  resetSelection,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  active: boolean;
  generation: React.MutableRefObject<number>;
  reloadNonce: number;
  resetSelection: () => void;
}) {
  const [inventory, setInventory] = useState<ClaudeCodeMcpServersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    generation.current += 1;
    const current = generation.current;
    setInventory(null);
    setError(null);
    resetSelection();
    if (!active || !agentId || !sessionId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const response = await claudeCodeApi.claudeCodeMcpServers({
          agent_id: agentId,
          session_id: sessionId,
        });
        if (generation.current !== current) {
          return;
        }
        if (response.state === 'ready') {
          setInventory(response);
        } else {
          // `unavailable`, `unsupported` and `error` are answers, and none of
          // them is an empty list: an offline Agent or an unobservable Session
          // must not render as "this user has no servers".
          setError(
            response.error ??
              `Claude MCP configuration is ${response.state.replace('_', ' ')}`,
          );
        }
      } catch (caught) {
        if (generation.current === current) {
          setError(errorMessage(caught));
        }
      } finally {
        if (generation.current === current) {
          setLoading(false);
        }
      }
    })();
  }, [active, agentId, generation, reloadNonce, resetSelection, sessionId]);

  return { inventory, loading, error };
}

function useSelection({
  agentId,
  sessionId,
  generation,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  generation: React.MutableRefObject<number>;
}) {
  const [selection, setSelection] = useState<McpSelection | null>(null);
  const [detail, setDetail] = useState<ClaudeCodeMcpServerResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ClaudeCodeMcpProbe | null>(null);

  const reset = useCallback(() => {
    setSelection(null);
    setDetail(null);
    setProbe(null);
    setDetailError(null);
  }, []);

  const select = useCallback(
    async (entry: Pick<ClaudeCodeMcpEntry, 'name' | 'scope'>) => {
      if (!agentId || !sessionId) {
        return;
      }
      const current = generation.current;
      setSelection({ name: entry.name, scope: entry.scope });
      setDetail(null);
      setProbe(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const response = await claudeCodeApi.claudeCodeMcpServer({
          agent_id: agentId,
          session_id: sessionId,
          name: entry.name,
          scope: entry.scope,
          probe: false,
          allow_stdio: false,
        });
        if (generation.current !== current) {
          return;
        }
        setDetail(response);
        if (response.state === 'error' || response.state === 'unavailable') {
          setDetailError(response.error ?? 'The entry could not be read');
        }
      } catch (caught) {
        if (generation.current === current) {
          setDetailError(errorMessage(caught));
        }
      } finally {
        if (generation.current === current) {
          setDetailLoading(false);
        }
      }
    },
    [agentId, generation, sessionId],
  );

  const inspect = useCallback(
    async (allowStdio: boolean) => {
      if (!agentId || !sessionId || !selection) {
        return;
      }
      const current = generation.current;
      setDetailLoading(true);
      try {
        const response = await claudeCodeApi.claudeCodeMcpServer({
          agent_id: agentId,
          session_id: sessionId,
          name: selection.name,
          scope: selection.scope,
          probe: true,
          allow_stdio: allowStdio,
        });
        if (generation.current !== current) {
          return;
        }
        setDetail(response);
        setProbe(response.probe);
      } catch (caught) {
        if (generation.current === current) {
          setDetailError(errorMessage(caught));
        }
      } finally {
        if (generation.current === current) {
          setDetailLoading(false);
        }
      }
    },
    [agentId, generation, selection, sessionId],
  );

  return {
    selection,
    detail,
    detailLoading,
    detailError,
    probe,
    reset,
    select,
    inspect,
  };
}

function useActions({
  agentId,
  sessionId,
  generation,
  reload,
  select,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  generation: React.MutableRefObject<number>;
  reload: () => void;
  select: (entry: Pick<ClaudeCodeMcpEntry, 'name' | 'scope'>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const mutate = useCallback(
    async (input: MutationInput): Promise<ClaudeCodeMcpMutateResponse | null> => {
      if (!agentId || !sessionId) {
        return null;
      }
      const current = generation.current;
      setBusy(true);
      setActionError(null);
      try {
        const response = await claudeCodeApi.claudeCodeMcpMutate({
          agent_id: agentId,
          session_id: sessionId,
          ...input,
        });
        if (generation.current !== current) {
          return response;
        }
        if (response.state === 'ok') {
          reload();
          if (response.entry) {
            void select(response.entry);
          }
        } else {
          setActionError(response.error ?? 'The MCP configuration was not changed');
        }
        return response;
      } catch (caught) {
        if (generation.current === current) {
          setActionError(errorMessage(caught));
        }
        return null;
      } finally {
        if (generation.current === current) {
          setBusy(false);
        }
      }
    },
    [agentId, generation, reload, select, sessionId],
  );

  const connect = useCallback(
    async (input: ConnectInput): Promise<ClaudeCodeMcpConnectResponse | null> => {
      if (!agentId || !sessionId) {
        return null;
      }
      const current = generation.current;
      setBusy(true);
      setActionError(null);
      try {
        const response = await claudeCodeApi.claudeCodeMcpConnect({
          agent_id: agentId,
          session_id: sessionId,
          ...input,
        });
        if (generation.current !== current) {
          return response;
        }
        if (
          response.state === 'configured' ||
          response.state === 'already_configured'
        ) {
          reload();
        } else if (response.state === 'error') {
          setActionError(response.error ?? 'The Nession MCP entry was not written');
        }
        return response;
      } catch (caught) {
        if (generation.current === current) {
          setActionError(errorMessage(caught));
        }
        return null;
      } finally {
        if (generation.current === current) {
          setBusy(false);
        }
      }
    },
    [agentId, generation, reload, sessionId],
  );

  return { busy, actionError, setActionError, mutate, connect };
}

export function useMcp({
  agentId,
  sessionId,
  active,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  active: boolean;
}) {
  const sessionKey = agentId && sessionId ? `${agentId}:${sessionId}` : null;
  const generation = useRef(0);
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => {
    setReloadNonce((nonce) => nonce + 1);
  }, []);
  const selection = useSelection({ agentId, sessionId, generation });
  const inventory = useInventory({
    agentId,
    sessionId,
    active,
    generation,
    reloadNonce,
    resetSelection: selection.reset,
  });
  const actions = useActions({
    agentId,
    sessionId,
    generation,
    reload,
    select: selection.select,
  });
  return {
    sessionKey,
    ...inventory,
    ...selection,
    ...actions,
    clearSelection: selection.reset,
    reload,
  };
}

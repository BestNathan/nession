import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import {
  defaultArguments,
  parseArgumentsDraft,
  redactSecrets,
  validateArguments,
} from '../model';
import type {
  McpCallRecord,
  McpCallResult,
  McpInventory,
  McpProbeResult,
  McpServerEntry,
  McpServerMutation,
  McpTool,
  McpUiProvider,
} from '../types';

export type McpRunStatus =
  | 'idle'
  | 'confirmation_required'
  | 'running'
  | 'success'
  | 'isError'
  | 'cancelled'
  | 'timeout'
  | 'failed';

export interface McpRunOutcome {
  state: 'confirmation_required' | 'invalid' | 'blocked' | 'completed';
  error?: string;
}

const HISTORY_LIMIT = 5;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The MCP operation failed';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

interface McpKitFence {
  contextMatches: boolean;
  contextKey: string;
  hostKey: string;
  generation: MutableRefObject<number>;
  mounted: MutableRefObject<boolean>;
}

/** The inventory read. It is the only request a mounted view performs. */
function useMcpInventory(provider: McpUiProvider, fence: McpKitFence) {
  const [inventory, setInventory] = useState<McpInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { contextMatches, contextKey, generation, hostKey, mounted } = fence;

  const load = useCallback(async () => {
    const forGeneration = generation.current;
    setLoading(true);
    setError(null);
    try {
      const answer = await provider.listServers();
      if (generation.current !== forGeneration || !mounted.current) {
        return;
      }
      setInventory(answer);
      if (answer.state !== 'ready') {
        setError(answer.error ?? `MCP configuration is ${answer.state.replace('_', ' ')}`);
      }
    } catch (failure) {
      if (generation.current === forGeneration && mounted.current) {
        setInventory(null);
        setError(errorMessage(failure));
      }
    } finally {
      if (generation.current === forGeneration && mounted.current) {
        setLoading(false);
      }
    }
  }, [generation, mounted, provider]);

  useEffect(() => {
    setInventory(null);
    setError(null);
    setLoading(false);
    if (contextMatches) {
      void load();
    }
    // The context keys are the reset; `load` is stable for one provider.
  }, [contextKey, hostKey, contextMatches, load]);

  return { inventory, inventoryLoading: loading, inventoryError: error, reloadInventory: load };
}

/** Selection and the explicit connection probe. Opening a server does not probe. */
function useMcpSelection(provider: McpUiProvider, fence: McpKitFence) {
  const [selection, setSelection] = useState<McpServerEntry | null>(null);
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const { contextMatches, contextKey, generation, hostKey, mounted } = fence;

  useEffect(() => {
    setSelection(null);
    setProbe(null);
    setProbing(false);
    setProbeError(null);
  }, [contextKey, hostKey]);

  const selectServer = useCallback((server: McpServerEntry | null) => {
    setSelection(server);
    setProbe(null);
    setProbeError(null);
    setProbing(false);
  }, []);

  const probeConnection = useCallback(
    async (options: { allowStdio: boolean }) => {
      if (
        !contextMatches ||
        !selection ||
        !provider.capabilities.probe ||
        !provider.probeServer
      ) {
        return null;
      }
      if (selection.credential === 'missing') {
        setProbeError('Credential binding is missing. No implicit token export.');
        return null;
      }
      const forGeneration = generation.current;
      setProbing(true);
      setProbeError(null);
      setProbe(null);
      try {
        const answer = await provider.probeServer(selection.name, selection.scope, options);
        if (generation.current !== forGeneration || !mounted.current) {
          return null;
        }
        setProbe(answer);
        if (answer.status !== 'ok') {
          setProbeError(answer.error ?? answer.detail ?? `Probe ${answer.status}`);
        }
        return answer;
      } catch (failure) {
        if (generation.current === forGeneration && mounted.current) {
          setProbeError(errorMessage(failure));
        }
        return null;
      } finally {
        if (generation.current === forGeneration && mounted.current) {
          setProbing(false);
        }
      }
    },
    [contextMatches, generation, mounted, provider, selection],
  );

  return { selection, selectServer, probe, probing, probeError, probeConnection };
}

/** Configuration mutation, authorized only by the adapter. */
function useMcpMutation(
  provider: McpUiProvider,
  fence: McpKitFence,
  reloadInventory: () => Promise<void>,
) {
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const { contextMatches, contextKey, generation, hostKey, mounted } = fence;

  useEffect(() => {
    setMutationBusy(false);
    setMutationError(null);
    setMutationNotice(null);
  }, [contextKey, hostKey]);

  const mutateServer = useCallback(
    async (mutation: McpServerMutation): Promise<boolean> => {
      if (!contextMatches || !provider.capabilities.configuration || !provider.mutateServer) {
        setMutationError('This adapter does not support configuration changes.');
        return false;
      }
      const forGeneration = generation.current;
      setMutationBusy(true);
      setMutationError(null);
      setMutationNotice(null);
      try {
        const answer = await provider.mutateServer(mutation);
        if (generation.current !== forGeneration || !mounted.current) {
          return false;
        }
        if (answer.state === 'ok') {
          setMutationNotice(
            mutation.action === 'remove'
              ? `Removed ${mutation.name} from ${mutation.scope} configuration.`
              : `Saved ${mutation.name} in ${mutation.scope} configuration.`,
          );
          await reloadInventory();
          return true;
        }
        setMutationError(
          answer.message ?? `The configuration was not changed (${answer.state})`,
        );
        return false;
      } catch (failure) {
        if (generation.current === forGeneration && mounted.current) {
          setMutationError(errorMessage(failure));
        }
        return false;
      } finally {
        if (generation.current === forGeneration && mounted.current) {
          setMutationBusy(false);
        }
      }
    },
    [contextMatches, generation, mounted, provider, reloadInventory],
  );

  return { mutationBusy, mutationError, mutationNotice, mutateServer };
}

function runBlockReason({
  contextMatches,
  selection,
  provider,
  probe,
}: {
  contextMatches: boolean;
  selection: McpServerEntry | null;
  provider: McpUiProvider;
  probe: McpProbeResult | null;
}): string | null {
  if (!contextMatches) {
    return 'The Session context changed; the result was dropped.';
  }
  if (!selection) {
    return 'No MCP server is selected.';
  }
  if (!provider.capabilities.invocation || !provider.invokeTool) {
    return 'This adapter does not support Tool invocation.';
  }
  if (probe?.status !== 'ok') {
    return 'Connect and discover Tools before invoking one.';
  }
  return null;
}

interface RunState {
  status: McpRunStatus;
  error: string | null;
  result: McpCallResult | null;
  history: readonly McpCallRecord[];
  setStatus: (status: McpRunStatus) => void;
  setError: (message: string | null) => void;
  setResult: (result: McpCallResult | null) => void;
  record: (entry: Omit<McpCallRecord, 'id'>) => void;
  selectHistory: (entry: McpCallRecord) => void;
  resetDraft: (tool: McpTool) => Record<string, unknown>;
}

function settleFailure({
  failure,
  timedOut,
  toolName,
  state,
}: {
  failure: unknown;
  timedOut: boolean;
  toolName: string;
  state: Pick<RunState, 'setStatus' | 'setError' | 'record'>;
}) {
  if (isAbort(failure)) {
    const status = timedOut ? 'timeout' : 'cancelled';
    state.setStatus(status);
    state.setError(timedOut ? 'The Tool call timed out.' : 'The Tool call was cancelled.');
    state.record({ tool: toolName, status, at: new Date().toISOString() });
    return;
  }
  const message = errorMessage(failure);
  state.setStatus('failed');
  state.setError(message);
  state.record({ tool: toolName, status: 'failed', at: new Date().toISOString(), error: message });
}

/** Run state and local history; reset by a Session change, never persisted. */
function useRunState(fence: McpKitFence): RunState {
  const [status, setStatus] = useState<McpRunStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<McpCallResult | null>(null);
  const [history, setHistory] = useState<readonly McpCallRecord[]>([]);
  const { contextKey, hostKey } = fence;

  useEffect(() => {
    setStatus('idle');
    setError(null);
    setResult(null);
    setHistory([]);
  }, [contextKey, hostKey]);

  const record = useCallback((entry: Omit<McpCallRecord, 'id'>) => {
    setHistory((previous) =>
      [{ ...entry, id: (previous[0]?.id ?? 0) + 1 }, ...previous].slice(0, HISTORY_LIMIT),
    );
  }, []);

  const selectHistory = useCallback((entry: McpCallRecord) => {
    if (!entry.result) {
      return;
    }
    setResult(entry.result);
    setStatus(entry.status === 'isError' ? 'isError' : 'success');
    setError(entry.error ?? null);
  }, []);

  const resetDraft = useCallback((tool: McpTool) => defaultArguments(tool), []);

  return {
    status,
    error,
    result,
    history,
    setStatus,
    setError,
    setResult,
    record,
    selectHistory,
    resetDraft,
  };
}

/** One explicit `tools/call`, with confirmation, timeout, cancel and history. */
function useRunExecution({
  provider,
  fence,
  selection,
  probe,
  timeoutMs,
  state,
}: {
  provider: McpUiProvider;
  fence: McpKitFence;
  selection: McpServerEntry | null;
  probe: McpProbeResult | null;
  timeoutMs: number;
  state: RunState;
}) {
  const sequence = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const { contextMatches, contextKey, generation, hostKey } = fence;
  const { record, setError, setResult, setStatus } = state;

  useEffect(() => {
    sequence.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, [contextKey, hostKey]);

  const cancelRun = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const runTool = useCallback(
    async (
      tool: McpTool,
      draft: Record<string, unknown>,
      options: { confirmed: boolean },
    ): Promise<McpRunOutcome> => {
      const blocked = runBlockReason({ contextMatches, selection, provider, probe });
      if (blocked) {
        return { state: 'blocked', error: blocked };
      }
      const invalid = validateArguments(tool, draft);
      if (invalid) {
        setStatus('idle');
        setError(invalid);
        return { state: 'invalid', error: invalid };
      }
      // Unknown side effects fail closed: only an adapter-declared read runs
      // without a second confirmation.
      if (tool.effect !== 'read' && !options.confirmed) {
        setStatus('confirmation_required');
        return { state: 'confirmation_required' };
      }
      const target = selection;
      const invoke = provider.invokeTool;
      if (!target || !invoke) {
        return { state: 'blocked', error: 'This adapter cannot execute this call.' };
      }
      const forGeneration = generation.current;
      const forRun = ++sequence.current;
      const controller = new AbortController();
      abortRef.current = controller;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      setStatus('running');
      setError(null);
      setResult(null);
      try {
        const answer = await invoke(
          target.name,
          target.scope,
          tool.name,
          draft,
          controller.signal,
        );
        if (generation.current !== forGeneration || sequence.current !== forRun) {
          return { state: 'completed' };
        }
        setResult(answer);
        setStatus(answer.isError ? 'isError' : 'success');
        record({
          tool: tool.name,
          status: answer.isError ? 'isError' : 'success',
          at: new Date().toISOString(),
          result: answer,
        });
      } catch (failure) {
        if (generation.current === forGeneration && sequence.current === forRun) {
          settleFailure({
            failure,
            timedOut,
            toolName: tool.name,
            state: { setStatus, setError, record },
          });
        }
      } finally {
        clearTimeout(timer);
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
      return { state: 'completed' };
    },
    [
      contextMatches,
      generation,
      probe,
      provider,
      record,
      selection,
      setError,
      setResult,
      setStatus,
      timeoutMs,
    ],
  );

  return { runTool, cancelRun };
}

/**
 * The kit's local view state (#3772).
 *
 * Owns exactly what belongs to presentation: the inventory read, selection,
 * an explicit probe, an explicit call's result/history, and the fences that
 * stop a previous Session's answer from publishing under a new one.
 *
 * It never probes, launches, or invokes on its own: `listServers` is the only
 * call made when a view mounts. Probe, mutation and `tools/call` are reached
 * only through the returned actions.
 */
export function useMcpKit({
  provider,
  agentId,
  sessionId,
  timeoutMs = 30_000,
}: {
  provider: McpUiProvider;
  agentId: string | undefined;
  sessionId: string | undefined;
  timeoutMs?: number;
}) {
  const contextMatches =
    provider.context.agentId === agentId && provider.context.sessionId === sessionId;
  const contextKey = `${provider.context.agentId}\u0000${provider.context.sessionId}`;
  const hostKey = `${agentId ?? ''}\u0000${sessionId ?? ''}`;
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    generation.current += 1;
  }, [contextKey, hostKey]);

  const fence: McpKitFence = { contextMatches, contextKey, hostKey, generation, mounted };
  const inventory = useMcpInventory(provider, fence);
  const selection = useMcpSelection(provider, fence);
  const mutation = useMcpMutation(provider, fence, inventory.reloadInventory);
  const runState = useRunState(fence);
  const execution = useRunExecution({
    provider,
    fence,
    selection: selection.selection,
    probe: selection.probe,
    timeoutMs,
    state: runState,
  });

  return {
    contextMatches,
    ...inventory,
    ...selection,
    ...mutation,
    runStatus: runState.status,
    runError: runState.error,
    result: runState.result,
    history: runState.history,
    selectHistory: runState.selectHistory,
    resetDraft: runState.resetDraft,
    runTool: execution.runTool,
    cancelRun: execution.cancelRun,
    parseDraft: parseArgumentsDraft,
    redact: redactSecrets,
  };
}

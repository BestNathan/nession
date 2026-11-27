import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent, ProbedAddress } from '@/types';
import { agentsApi } from '@/product/agent';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

function trackHeartbeats(newAgents: Agent[], map: Map<string, string[]>) {
  for (const agent of newAgents) {
    if (!agent.last_heartbeat) { continue; }
    const history = map.get(agent.agent_id) ?? [];
    history.push(agent.last_heartbeat);
    if (history.length > 5) { history.splice(0, history.length - 5); }
    map.set(agent.agent_id, history);
  }
}

function addressesEqual(a: ProbedAddress[] = [], b: ProbedAddress[] = []): boolean {
  if (a.length !== b.length) { return false; }
  return a.every((left, i) => {
    const right = b[i];
    return left.url === right.url
      && left.label === right.label
      && left.network_type === right.network_type
      && left.priority === right.priority
      && left.status === right.status
      && left.rtt_ms === right.rtt_ms;
  });
}

function metadataEqual(a: Agent['metadata'], b: Agent['metadata']): boolean {
  if (a === b) { return true; }
  if (!a || !b) { return false; }
  return a.tmux_version === b.tmux_version
    && a.os_version === b.os_version
    && a.nession_version === b.nession_version
    && a.image_tag === b.image_tag
    && a.architecture === b.architecture
    && a.os === b.os
    && a.variant === b.variant;
}

/**
 * Whether two agent snapshots carry the same facts.
 *
 * Every field the wire can change is compared (#4602 SC-04). The previous
 * key covered only id/status/counts/name, so a changed address probe, protocol
 * manifest, hostname, port, version metadata or heartbeat was swallowed and the
 * UI kept rendering the old value. Deduplication is still worth having — an
 * unchanged poll must not re-render every row — but it may only skip a snapshot
 * that is genuinely identical, never one that differs in a field nobody
 * happened to list.
 *
 * `protocols` is compared by identity of its serialized form because it is a
 * nested manifest whose shape belongs to the protocol owner, not to this hook.
 */
export function agentsEqual(a: Agent[], b: Agent[]): boolean {
  if (a === b) { return true; }
  if (a.length !== b.length) { return false; }
  return a.every((left, i) => {
    const right = b[i];
    return left.agent_id === right.agent_id
      && left.hostname === right.hostname
      && left.display_name === right.display_name
      && left.ip_address === right.ip_address
      && left.port === right.port
      && left.status === right.status
      && left.session_count === right.session_count
      && left.active_sessions === right.active_sessions
      && left.last_heartbeat === right.last_heartbeat
      && left.registered_at === right.registered_at
      && metadataEqual(left.metadata, right.metadata)
      && addressesEqual(left.addresses, right.addresses)
      && JSON.stringify(left.protocols ?? null) === JSON.stringify(right.protocols ?? null);
  });
}

/** Session/Agent cadence from #4602 §2: live registry state, 10–15s. */
const AGENT_LIST_POLICY: PullRefreshPolicy = {
  intervalMs: 12_000,
  minIntervalMs: 2_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

export interface AgentDataOptions {
  /** Transport identity. A change retires the previous read context. */
  connectionRevision?: number;
  /** Authenticated transport readiness. */
  enabled?: boolean;
  /** Whether a visible consumer actually needs the list right now. */
  active?: boolean;
}

/**
 * Agents data: state, fetch, heartbeat history tracking.
 *
 * The list itself stays here; *when* it is read and *whether an answer may
 * still be published* belong to the shared pull controller (#4602). A failure
 * keeps the last known registry and marks it stale rather than emptying the
 * sidebar, and a background read never raises the initial-load spinner.
 */
export function useAgentData(options: AgentDataOptions = {}) {
  const { connectionRevision = 0, enabled = true, active = true } = options;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const heartbeatHistory = useRef<Map<string, string[]>>(new Map());
  const published = useRef<Agent[]>([]);

  const apply = useCallback((snapshot: Agent[]) => {
    trackHeartbeats(snapshot, heartbeatHistory.current);
    if (agentsEqual(published.current, snapshot)) { return; }
    published.current = snapshot;
    setAgents(snapshot);
  }, []);

  const { refresh, invalidate, acceptExternal, status } = usePullRefresh<Agent[]>({
    context: ['agent-list', connectionRevision],
    active,
    enabled,
    pull: () => agentsApi.listAgents(),
    apply,
    policy: AGENT_LIST_POLICY,
    label: 'agent-list',
  });

  useEffect(() => {
    setError(status.error);
  }, [status.error]);

  const getHeartbeatHistory = useCallback((agentId: string): string[] => {
    return heartbeatHistory.current.get(agentId) ?? [];
  }, []);

  /** A complete push snapshot, fenced against any outstanding read. */
  const applyAgentUpdate = useCallback((newAgents: Agent[]) => {
    acceptExternal(newAgents);
  }, [acceptExternal]);

  /** Replace a single agent in the list (used after rename). */
  const updateAgent = useCallback((updated: Agent) => {
    const next = published.current.map((a) => (a.agent_id === updated.agent_id ? updated : a));
    published.current = next;
    setAgents(next);
    // The rename is authoritative post-state; ask for the registry again so a
    // concurrent change elsewhere is not missed.
    invalidate('mutation');
  }, [invalidate]);

  /** Targeted re-read after a mutation the caller performed. */
  const fetchAgents = useCallback(async (): Promise<void> => {
    await refresh('mutation');
  }, [refresh]);

  /** Explicit user refresh of the whole registry. */
  const refreshAgents = useCallback(() => refresh('manual'), [refresh]);

  return {
    agents, setAgents,
    loadingAgents: status.loading,
    refreshingAgents: status.refreshing,
    agentsStale: status.stale,
    error, setError,
    fetchAgents,
    refreshAgents,
    getHeartbeatHistory,
    applyAgentUpdate,
    updateAgent,
  };
}
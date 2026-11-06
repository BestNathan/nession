import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import { WIRE as SESSION_METADATA_GET_WIRE } from '@/generated/protocol/core/server-session-metadata-get/v1';
import { WIRE as SESSION_METADATA_UPDATE_WIRE } from '@/generated/protocol/core/server-session-metadata-update/v1';
import { WIRE as SESSION_PROCESSES_WIRE } from '@/generated/protocol/core/server-session-processes/v1';
import { sessionsApi } from '@/product/session';
import type { ProcessSnapshot } from '@/product/agent/types';
import type { Agent, Session } from '@/types';
import { fixtureSessionMetadataSurface } from './fixtureSessionMetadata';

/**
 * The two-Agent process-discovery fixture (#2803).
 *
 * Session identity is `agent_id:session_name`, not the display name, and the
 * defect this route exists to make observable is a switch between
 * `agent-a:dev` and `agent-b:dev` — two different Sessions that share the name
 * `dev`. The route therefore supplies both Agents and both Sessions and lets a
 * Case move the *current Session* through the same state a Workspace move uses;
 * it never names a rendering.
 *
 *   /#/fixture/workspace?capability=agent&agentProcesses=normal
 *   /#/fixture/workspace?capability=agent&agentProcesses=offline
 *   /#/fixture/workspace?capability=agent&agentProcesses=error
 *   /#/fixture/workspace?capability=agent&agentProcesses=pending
 *
 * `offline` reports Agent B as offline (no read is made), `error` answers B's
 * read with a refusal, and `pending` holds B's read until the Case releases it.
 * Agent A always answers deterministically with its own distinguishable
 * sanitized command, so any of its rows appearing under B is a visible
 * cross-Session leak.
 */
export type FixtureAgentProcessesScenario = 'normal' | 'offline' | 'error' | 'pending';

export function fixtureAgentProcessesScenario(
  search: string,
): FixtureAgentProcessesScenario | null {
  const requested = new URLSearchParams(search).get('agentProcesses');
  if (
    requested === 'normal' ||
    requested === 'offline' ||
    requested === 'error' ||
    requested === 'pending'
  ) {
    return requested;
  }
  return null;
}

export const FIXTURE_AGENT_PROCESS_DEFAULT_SESSION_ID = 'agent-a:dev';

function agentWith(agentId: string, status: Agent['status']): Agent {
  return {
    agent_id: agentId,
    hostname: agentId,
    display_name: agentId,
    ip_address: agentId === 'agent-a' ? '10.0.0.31' : '10.0.0.32',
    port: 19091,
    status,
    session_count: 1,
    last_heartbeat: '2026-09-01T08:00:00Z',
  };
}

/** The two Agents: A always online, B offline only in the offline scenario. */
export function fixtureAgentProcessesAgents(
  scenario: FixtureAgentProcessesScenario,
): Agent[] {
  return [
    agentWith('agent-a', 'online'),
    agentWith('agent-b', scenario === 'offline' ? 'offline' : 'online'),
  ];
}

/** Two Sessions with the same name on different Agents. */
export const FIXTURE_AGENT_PROCESS_SESSIONS: Session[] = [
  {
    session_id: 'agent-a:dev',
    agent_id: 'agent-a',
    session_name: 'dev',
    status: 'active',
    window_count: 1,
    attached_clients: 1,
    foreground_command: 'bash',
    last_activity: '2026-09-01T08:00:00Z',
  },
  {
    session_id: 'agent-b:dev',
    agent_id: 'agent-b',
    session_name: 'dev',
    status: 'active',
    window_count: 1,
    attached_clients: 1,
    foreground_command: 'bash',
    last_activity: '2026-09-01T08:00:00Z',
  },
];

const SNAPSHOT_AT_MS = 1_762_300_000_000;

function snapshotFor(
  sessionName: string,
  pid: number,
  command: string,
  cpuPercent: number,
): ProcessSnapshot {
  return {
    session_name: sessionName,
    snapshot_at_ms: SNAPSHOT_AT_MS,
    platform: 'linux',
    methods: ['process_tree'],
    panes: [
      {
        session_ids: ['$0'],
        session_names: [sessionName],
        window_id: '@0',
        window_index: 0,
        window_name: 'shell',
        pane_id: '%0',
        pane_index: 0,
        pane_pid: pid,
        pane_tty: '/dev/pts/1',
        method: 'process_tree',
        coverage: 'partial',
        reason_codes: ['no_dedicated_cgroup'],
        processes: [
          {
            pid,
            parent_pid: 1,
            start_time_ms: SNAPSHOT_AT_MS - 60_000,
            tty: '/dev/pts/1',
            sid: 100,
            pgid: 100,
            executable: command.split(' ')[0],
            command,
            command_state: 'sampled',
            command_reason: null,
            redacted: true,
            truncated: false,
            cpu_percent: { value: cpuPercent, state: 'sampled' },
            rss_mib: { value: 42, state: 'sampled' },
            threads: { value: 3, state: 'sampled' },
            elapsed_ms: { value: 60_000, state: 'sampled' },
            io_read_kib_per_s: { value: 1, state: 'sampled' },
            io_write_kib_per_s: { value: 0, state: 'sampled' },
          },
        ],
      },
    ],
    truncated: false,
    limits: { max_processes: 512, max_depth: 32, cpu_window_ms: 150 },
  };
}

/** Distinguishable sanitized commands: A's text must never render under B. */
export const FIXTURE_AGENT_PROCESS_COMMAND_A =
  'agent-a-worker --task alpha --auth [REDACTED]';
export const FIXTURE_AGENT_PROCESS_COMMAND_B =
  'agent-b-worker --task beta --auth [REDACTED]';

const SNAPSHOT_A = snapshotFor('dev', 4101, FIXTURE_AGENT_PROCESS_COMMAND_A, 11);
const SNAPSHOT_B = snapshotFor('dev', 4201, FIXTURE_AGENT_PROCESS_COMMAND_B, 22);

export interface FixtureAgentProcessesControls {
  /** Settle the held `agent-b:dev` read (pending scenario). */
  releasePending(): void;
  /** Whether the held read has settled. */
  pendingSettled(): boolean;
  /** How many `agent-b:dev` reads this surface was asked for (no polling). */
  betaRequests(): number;
}

export interface FixtureAgentProcessesWindowControls extends FixtureAgentProcessesControls {
  select(sessionId: string): void;
  selected(): string;
}

export interface FixtureAgentProcessesWindow {
  fixtureAgentProcesses?: FixtureAgentProcessesWindowControls;
}

/** Which of the two same-name Sessions the fixture Workspace currently shows. */
let activeSessionId = FIXTURE_AGENT_PROCESS_DEFAULT_SESSION_ID;
const selectionListeners = new Set<() => void>();

export function fixtureAgentProcessSessionId(): string {
  return activeSessionId;
}

export function subscribeFixtureAgentProcessSession(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => {
    selectionListeners.delete(listener);
  };
}

/**
 * Move the fixture Workspace to another Session, as the product's Workspace
 * move would — the mounted Agent capability observes a changed `sessionId`
 * without remounting.
 */
export function selectFixtureAgentProcessSession(sessionId: string): void {
  if (
    sessionId === activeSessionId ||
    !FIXTURE_AGENT_PROCESS_SESSIONS.some((session) => session.session_id === sessionId)
  ) {
    return;
  }
  activeSessionId = sessionId;
  for (const listener of [...selectionListeners]) {
    listener();
  }
}

/**
 * A server-shaped surface for `server.session.processes`.
 *
 * It answers only what the Agent can answer and delegates every other wire to
 * the fixture's Session metadata store, so the route's other surfaces stay
 * reachable. The scenario names the environment input, never a rendering.
 */
export function createFixtureAgentProcessSurface(search: string): {
  surface: PluginSurface;
  controls: FixtureAgentProcessesControls;
} {
  const scenario = fixtureAgentProcessesScenario(search) ?? 'normal';
  const agents = fixtureAgentProcessesAgents(scenario);
  const metadata = fixtureSessionMetadataSurface(search);
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(agents));

  let betaRequests = 0;
  let releasePending: (() => void) | null = null;
  let pendingSettled = false;

  const surface: PluginSurface = {
    connectionState: 'connected',
    protocols,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      // This surface replaces the route's Session metadata binding, so the two
      // wires that store answers are delegated by their imported identities
      // rather than by a pass-through variable the protocol gate cannot read.
      if (type === SESSION_METADATA_GET_WIRE) {
        return metadata.request<T>(SESSION_METADATA_GET_WIRE, payload);
      }
      if (type === SESSION_METADATA_UPDATE_WIRE) {
        return metadata.request<T>(SESSION_METADATA_UPDATE_WIRE, payload);
      }
      if (type !== SESSION_PROCESSES_WIRE) {
        return Promise.reject(
          new Error(`fixture agent process surface does not answer ${type}`),
        );
      }
      const sessionId = String(payload.session_id ?? '');
      if (sessionId === 'agent-a:dev') {
        return Promise.resolve({ snapshot: SNAPSHOT_A } as T);
      }
      if (sessionId !== 'agent-b:dev') {
        return Promise.reject(
          new Error(`fixture agent process surface has no Session ${sessionId}`),
        );
      }
      betaRequests += 1;
      if (scenario === 'offline') {
        return Promise.reject(new Error('Agent agent-b is offline'));
      }
      if (scenario === 'error') {
        return Promise.reject(
          new Error('agent-b process discovery failed: permission denied'),
        );
      }
      if (scenario === 'pending') {
        return new Promise<T>((resolve) => {
          releasePending = () => {
            pendingSettled = true;
            resolve({ snapshot: SNAPSHOT_B } as T);
          };
        });
      }
      return Promise.resolve({ snapshot: SNAPSHOT_B } as T);
    },
    send(): void {},
    subscribe(): () => void {
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(): () => void {
      return () => {};
    },
  };

  return {
    surface,
    controls: {
      releasePending: () => {
        releasePending?.();
      },
      pendingSettled: () => pendingSettled,
      betaRequests: () => betaRequests,
    },
  };
}

/**
 * Bind the process surface for a fixture route's lifetime, and publish the
 * Case controls on the browser window (`fixtureGitOverlap`'s pattern).
 */
export function installFixtureAgentProcessSurface(search: string): () => void {
  if (fixtureAgentProcessesScenario(search) === null) {
    return () => {};
  }
  activeSessionId = FIXTURE_AGENT_PROCESS_DEFAULT_SESSION_ID;
  const harness = createFixtureAgentProcessSurface(search);
  const release = sessionsApi.install(harness.surface);
  const controls: FixtureAgentProcessesWindowControls = {
    ...harness.controls,
    select: selectFixtureAgentProcessSession,
    selected: fixtureAgentProcessSessionId,
  };
  if (typeof window !== 'undefined') {
    (window as FixtureAgentProcessesWindow).fixtureAgentProcesses = controls;
  }
  return () => {
    release();
    if (
      typeof window !== 'undefined' &&
      (window as FixtureAgentProcessesWindow).fixtureAgentProcesses === controls
    ) {
      delete (window as FixtureAgentProcessesWindow).fixtureAgentProcesses;
    }
    activeSessionId = FIXTURE_AGENT_PROCESS_DEFAULT_SESSION_ID;
  };
}

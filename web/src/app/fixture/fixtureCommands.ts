import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { ConnectionState, PluginSurface, SocketMessage } from '@/platform/socket/types';
import type { ClientCommandsListResponsePayload, QuickCommandItem } from '@/capabilities/commands';
import { FIXTURE_AGENTS } from './fixtureData';

/**
 * Deterministic triggers the recovery scenarios expose to their Case.
 *
 * This is input, not rendering: the Case chooses when the server pushes a
 * change or the link reconnects, instead of waiting a guessed amount of time.
 * Guarded for the node-env unit project, which has no `window`.
 */
type FixtureCommandsWindow = Window & {
  fixtureCommandsChanged?: () => void;
  fixtureCommandsReconnect?: () => void;
};

/**
 * The saved-command backend for the fixture route (#2710).
 *
 * The canonical route is offline, so nothing answers `server.commands.list`.
 * This stands in with deterministic server-shaped data, which is what lets the
 * Commands view be captured and driven in a real browser.
 *
 * The route names an *input*, never a rendering:
 *
 *   /#/fixture/app                     → five saved commands
 *   /#/fixture/app?commands=none       → an empty saved list
 *   /#/fixture/app?commands=error      → every read is the server's failed read
 *   /#/fixture/app?commands=disconnected → the server link is down
 *   /#/fixture/app?commands=recover    → the first read fails; Retry succeeds
 *   /#/fixture/app?commands=changed    → the first read fails; the Case fires
 *     `window.fixtureCommandsChanged()`, then the refetch succeeds
 *   /#/fixture/app?commands=reconnect  → the link starts down and the first
 *     read fails; the Case fires `window.fixtureCommandsReconnect()`, then the
 *     reconnect refetch succeeds
 */
export function fixtureCommandsSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('commands') ?? 'ready';
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  let listRequests = 0;
  let connected = scenario !== 'disconnected' && scenario !== 'reconnect';
  const changedListeners = new Set<(payload: unknown, raw: SocketMessage) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  /** The server's failed-read shape: an empty list plus a generic message. */
  const failedRead = (): ClientCommandsListResponsePayload => ({
    commands: [],
    error: 'Saved commands could not be loaded',
  });
  const readCommands = (): ClientCommandsListResponsePayload => ({
    commands: FIXTURE_COMMANDS,
  });

  if (typeof window !== 'undefined') {
    const controls = window as FixtureCommandsWindow;
    if (scenario === 'changed') {
      controls.fixtureCommandsChanged = () => {
        for (const listener of changedListeners) {
          listener(undefined, undefined as unknown as SocketMessage);
        }
      };
    }
    if (scenario === 'reconnect') {
      controls.fixtureCommandsReconnect = () => {
        if (connected) {
          return;
        }
        connected = true;
        for (const listener of stateListeners) {
          listener('connected');
        }
      };
    }
  }

  return {
    get connectionState(): ConnectionState {
      return connected ? 'connected' : 'disconnected';
    },
    protocols,
    request<T>(type: string): Promise<T> {
      if (type !== 'server.commands.list') {
        return Promise.reject(new Error(`fixture commands surface does not answer ${type}`));
      }
      listRequests += 1;
      // `disconnected` still has a list (the last one the client knew); only
      // the link is down. `error` is the server's failed-read reply
      // (`{ commands: [], error }`), which the adapter must reject rather
      // than present as "no saved commands yet" (#2784).
      if (scenario === 'error') {
        return Promise.resolve(failedRead() as T);
      }
      if (
        (scenario === 'recover' || scenario === 'changed' || scenario === 'reconnect') &&
        listRequests === 1
      ) {
        return Promise.resolve(failedRead() as T);
      }
      const payload = scenario === 'none' ? { commands: [] } : readCommands();
      return Promise.resolve(payload as T);
    },
    send(): void {},
    subscribe(
      type: string,
      listener: (payload: unknown, raw: SocketMessage) => void,
    ): () => void {
      if (type === 'server.commands.changed') {
        changedListeners.add(listener);
        return () => {
          changedListeners.delete(listener);
        };
      }
      return () => {};
    },
    onBinary(): () => void {
      return () => {};
    },
    waitForConnection(): Promise<void> {
      return Promise.resolve();
    },
    onConnectionStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
}

/**
 * The shapes the real list can produce: a label and a command, in the server's
 * `sort_order`. Ids are stable so a row's test id names the command, not its
 * position.
 */
const FIXTURE_COMMANDS: QuickCommandItem[] = [
  {
    id: 'fixture-git-status',
    label: 'Git status',
    command: 'git status --short',
    raw: false,
    sort_order: 0,
    created_at: 1,
  },
  {
    id: 'fixture-tests',
    label: 'Run Rust tests',
    command: 'cargo test -q',
    raw: false,
    sort_order: 1,
    created_at: 2,
  },
  {
    id: 'fixture-tmux',
    label: 'List tmux sessions',
    command: 'tmux list-sessions',
    raw: false,
    sort_order: 2,
    created_at: 3,
  },
  {
    id: 'fixture-pods',
    label: 'Show Kubernetes pods',
    command: 'kubectl get pods -A',
    raw: false,
    sort_order: 3,
    created_at: 4,
  },
  {
    id: 'fixture-logs',
    label: 'Inspect recent logs',
    command: 'journalctl -n 80 --no-pager',
    raw: false,
    sort_order: 4,
    created_at: 5,
  },
];

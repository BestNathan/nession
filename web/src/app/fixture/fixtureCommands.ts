import { manifestsOf, ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import type { ClientCommandsListResponsePayload, QuickCommandItem } from '@/capabilities/commands';
import { FIXTURE_AGENTS } from './fixtureData';

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
 *   /#/fixture/app?commands=error      → the list request fails
 *   /#/fixture/app?commands=disconnected → the server link is down
 */
export function fixtureCommandsSurface(search: string): PluginSurface {
  const scenario = new URLSearchParams(search).get('commands') ?? 'ready';
  const protocols = new ProtocolDirectory();
  protocols.publish(manifestsOf(FIXTURE_AGENTS));

  return {
    connectionState: scenario === 'disconnected' ? 'disconnected' : 'connected',
    protocols,
    request<T>(type: string): Promise<T> {
      if (type !== 'server.commands.list') {
        return Promise.reject(new Error(`fixture commands surface does not answer ${type}`));
      }
      // `disconnected` still has a list (the last one the client knew); only
      // the link is down. `error` is the failed-load state.
      if (scenario === 'error') {
        return Promise.reject(new Error('fixture commands surface is unavailable'));
      }
      const commands = scenario === 'none' ? [] : FIXTURE_COMMANDS;
      const payload: ClientCommandsListResponsePayload = { commands };
      return Promise.resolve(payload as T);
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

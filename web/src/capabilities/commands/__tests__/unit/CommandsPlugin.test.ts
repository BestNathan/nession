import { describe, expect, it, vi } from 'vitest';
import { ProtocolDirectory } from '@/platform/protocol';
import type { ConnectionState, PluginSurface } from '@/platform/socket/types';
import { CommandsPlugin } from '@/capabilities/commands/CommandsPlugin';
import type { QuickCommandItem } from '@/capabilities/commands/types';

const COMMANDS: QuickCommandItem[] = [
  { id: 'one', label: 'Git status', command: 'git status', raw: false, sort_order: 0, created_at: 1 },
  { id: 'two', label: 'Tests', command: 'cargo test', raw: false, sort_order: 1, created_at: 2 },
];

function surface({
  commands = COMMANDS,
  state = 'connected' as ConnectionState,
  fail = false,
}: {
  commands?: QuickCommandItem[];
  state?: ConnectionState;
  fail?: boolean;
} = {}) {
  let pushChanged: (() => void) | null = null;
  let pushState: ((next: ConnectionState) => void) | null = null;
  const request = vi.fn(async (type: string) => {
    if (type !== 'server.commands.list') {
      throw new Error(`unexpected ${type}`);
    }
    if (fail) {
      throw new Error('offline');
    }
    return { commands };
  });
  const plugin: PluginSurface & {
    pushChanged: () => void;
    pushState: (next: ConnectionState) => void;
  } = {
    connectionState: state,
    protocols: new ProtocolDirectory(),
    request: request as PluginSurface['request'],
    send: vi.fn(),
    subscribe: (type, handler) => {
      if (type === 'server.commands.changed') {
        const receive = () => {
          handler(undefined, {} as never);
        };
        pushChanged = receive;
        return () => {
          if (pushChanged === receive) {
            pushChanged = null;
          }
        };
      }
      return () => {};
    },
    onBinary: () => () => {},
    waitForConnection: () => Promise.resolve(),
    onConnectionStateChange: (handler) => {
      pushState = handler;
      return () => {};
    },
    pushChanged: () => pushChanged?.(),
    pushState: (next) => pushState?.(next),
  };
  return { plugin, request };
}

describe('CommandsPlugin', () => {
  it('reads the ordered server list from server.commands.list', async () => {
    const { plugin, request } = surface();
    const commands = new CommandsPlugin();
    commands.install(plugin);

    await expect(commands.listCommands()).resolves.toEqual(COMMANDS);
    expect(request).toHaveBeenCalledWith('server.commands.list', {});
  });

  it('reports a rejected list instead of fabricating an empty list', async () => {
    const { plugin } = surface({ fail: true });
    const commands = new CommandsPlugin();
    commands.install(plugin);

    await expect(commands.listCommands()).rejects.toThrow('offline');
  });

  it('notifies changed listeners and stops after teardown', () => {
    const { plugin } = surface();
    const commands = new CommandsPlugin();
    const uninstall = commands.install(plugin);
    const listener = vi.fn();
    commands.onCommandsChanged(listener);

    plugin.pushChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    uninstall();
    plugin.pushChanged();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(commands.connectionState()).toBeNull();
  });

  it('delivers the current connection state on subscribe and on transitions', () => {
    const { plugin } = surface({ state: 'connected' });
    const commands = new CommandsPlugin();
    commands.install(plugin);
    const listener = vi.fn();

    const unsubscribe = commands.onConnectionStateChange(listener);
    expect(listener).toHaveBeenCalledWith('connected');

    plugin.pushState('disconnected');
    expect(listener).toHaveBeenLastCalledWith('disconnected');

    unsubscribe();
    plugin.pushState('connected');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolDirectory } from '@/platform/protocol';
import type { ConnectionState, PluginSurface } from '@/platform/socket/types';
import { commandsApi } from '@/capabilities/commands';
import type { QuickCommandItem } from '@/capabilities/commands/types';
import { QuickCommandsProjection } from '@/product/terminal/quickCommands/QuickCommandsProjection';

const COMMANDS: QuickCommandItem[] = [
  { id: 'one', label: 'Git status', command: 'git status --short', raw: false, sort_order: 0, created_at: 1 },
  { id: 'two', label: 'Run tests', command: 'cargo test -q', raw: false, sort_order: 1, created_at: 2 },
];

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function installSurface({
  commands = COMMANDS,
  state = 'connected' as ConnectionState,
  failures = 0,
}: {
  commands?: QuickCommandItem[];
  state?: ConnectionState;
  /** Fail this many list requests, then succeed (the Retry path). */
  failures?: number;
} = {}) {
  let remainingFailures = failures;
  let pushChanged: (() => void) | null = null;
  let pushState: ((next: ConnectionState) => void) | null = null;
  const request = vi.fn(async () => {
    if (remainingFailures > 0) {
      remainingFailures -= 1;
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
  uninstall = commandsApi.install(plugin);
  return { request, plugin };
}

function renderView({
  disabled = false,
}: {
  disabled?: boolean;
} = {}) {
  const insertText = vi.fn();
  const runCommand = vi.fn();
  render(
    <QuickCommandsProjection
      insertText={insertText}
      runCommand={runCommand}
      disabled={disabled}
    />,
  );
  return { insertText, runCommand };
}

describe('Quick Commands view (#2710 SC-05)', () => {
  it('shows the saved list in the server order with label and command preview', async () => {
    installSurface();
    renderView();

    const list = await screen.findByTestId('quick-commands-list');
    // Two rows; each row's two action buttons carry `quick-command-…` too.
    expect(list.children).toHaveLength(2);
    expect(screen.getByText('Git status')).toBeInTheDocument();
    expect(screen.getByText('git status --short')).toBeInTheDocument();
    expect(screen.getByTestId('quick-commands-count')).toHaveTextContent('2 commands');
  });

  it('does not execute anything merely by expanding the view', async () => {
    installSurface();
    const { insertText, runCommand } = renderView();

    await screen.findByTestId('quick-commands-list');

    expect(insertText).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('Insert sends the command text without Return and without executing', async () => {
    installSurface();
    const { insertText, runCommand } = renderView();

    await screen.findByTestId('quick-commands-list');
    await userEvent.click(screen.getByTestId('quick-command-insert-one'));

    expect(insertText).toHaveBeenCalledWith('git status --short');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('Run sends the command for execution and never inserts it instead', async () => {
    installSurface();
    const { insertText, runCommand } = renderView();

    await screen.findByTestId('quick-commands-list');
    await userEvent.click(screen.getByTestId('quick-command-run-two'));

    expect(runCommand).toHaveBeenCalledWith('cargo test -q');
    expect(insertText).not.toHaveBeenCalled();
  });

  it('explains an uncontrollable Session and disables both actions', async () => {
    installSurface();
    renderView({ disabled: true });

    await screen.findByTestId('quick-commands-list');

    expect(screen.getByTestId('quick-command-insert-one')).toBeDisabled();
    expect(screen.getByTestId('quick-command-run-one')).toBeDisabled();
    expect(screen.getByTestId('quick-commands-unavailable')).toHaveTextContent(
      'Terminal input is unavailable',
    );
  });

  it('keeps Insert usable while disconnected but explains why Run is not', async () => {
    installSurface({ state: 'disconnected' });
    renderView();

    await screen.findByTestId('quick-commands-list');

    // Insert is local composer text, so it can still work; Run cannot reach a
    // terminal, and the view says so instead of claiming success.
    expect(screen.getByTestId('quick-command-insert-one')).toBeEnabled();
    expect(screen.getByTestId('quick-command-run-one')).toBeDisabled();
    expect(screen.getByTestId('quick-commands-unavailable')).toHaveTextContent(
      'Run is unavailable',
    );
  });

  it('renders an empty saved list without inventing commands', async () => {
    installSurface({ commands: [] });
    renderView();

    expect(await screen.findByTestId('quick-commands-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-commands-list')).toBeNull();
  });

  it('recovers from a failed load through the explicit Retry action', async () => {
    const { request } = installSurface({ failures: 1 });
    renderView();

    await screen.findByTestId('quick-commands-error');
    expect(request).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId('quick-commands-retry'));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('quick-commands-list')).toBeInTheDocument();
  });

  it('refetches when the server pushes server.commands.changed', async () => {
    const { request, plugin } = installSurface();
    renderView();

    await screen.findByTestId('quick-commands-list');
    expect(request).toHaveBeenCalledTimes(1);

    plugin.pushChanged();

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
});

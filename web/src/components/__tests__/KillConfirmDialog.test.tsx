import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, KillSessionResponse } from '../../types';
import type { WebSocketService } from '../../services/websocket';
import { WebSocketContext } from '../../hooks/useWebSocket';

// Mock Dialog to render children directly (no portal)
vi.mock('../ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

let KillConfirmDialogModule: typeof import('../KillConfirmDialog');
beforeEach(async () => {
  KillConfirmDialogModule = await import('../KillConfirmDialog');
});

function makeSession(): Session {
  return {
    session_id: 'agent-1:my-session',
    agent_id: 'agent-1',
    session_name: 'my-session',
    status: 'active',
    window_count: 3,
    attached_clients: 1,
    last_activity: new Date().toISOString(),
  };
}

function makeWsService(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    killSession: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as unknown as WebSocketService;
}

/**
 * Killing is gated behind typing the session name, so every test that expects
 * the action to fire has to satisfy the guard first.
 */
async function typeSessionName(
  user: ReturnType<typeof userEvent.setup>,
  name = 'my-session',
) {
  await user.type(screen.getByRole('textbox'), name);
}

describe('KillConfirmDialog', () => {
  it('renders dialog when open', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Kill Session' })).toBeInTheDocument();
      // Shown twice: in the warning text and in the "type this to confirm" label.
      expect(screen.getAllByText(/my-session/).length).toBeGreaterThan(0);
    });
  });

  it('does not render when closed', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <KillConfirmDialog
          isOpen={false}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    expect(screen.queryByRole('heading', { name: 'Kill Session' })).not.toBeInTheDocument();
  });

  it('does not render when session is null', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={null}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    expect(screen.queryByRole('heading', { name: 'Kill Session' })).not.toBeInTheDocument();
  });

  it('has Cancel and Kill buttons', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });
  });

  it('calls onClose when Cancel clicked', async () => {
    const user = userEvent.setup();
    const { KillConfirmDialog } = KillConfirmDialogModule;
    const onClose = vi.fn();

    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <KillConfirmDialog
          isOpen={true}
          onClose={onClose}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls killSession on confirm', async () => {
    const user = userEvent.setup();
    const { KillConfirmDialog } = KillConfirmDialogModule;
    const wsService = makeWsService();

    render(
      <WebSocketContext.Provider value={wsService}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

    await typeSessionName(user);
    await user.click(screen.getByRole('button', { name: 'Kill Session' }));
    expect(wsService.killSession).toHaveBeenCalledWith('agent-1:my-session');
  });

  it('shows error when killSession returns success=false', async () => {
    const user = userEvent.setup();
    const { KillConfirmDialog } = KillConfirmDialogModule;
    const wsService = makeWsService();
    (wsService.killSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'Session not found',
    });

    render(
      <WebSocketContext.Provider value={wsService}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

    await typeSessionName(user);
    await user.click(screen.getByRole('button', { name: 'Kill Session' }));

    await waitFor(() => {
      expect(screen.getByText('Session not found')).toBeInTheDocument();
    });
  });

  it('shows error when killSession throws', async () => {
    const user = userEvent.setup();
    const { KillConfirmDialog } = KillConfirmDialogModule;
    const wsService = makeWsService();
    (wsService.killSession as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );

    render(
      <WebSocketContext.Provider value={wsService}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

    await typeSessionName(user);
    await user.click(screen.getByRole('button', { name: 'Kill Session' }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('shows generic error when killSession throws non-Error', async () => {
    const user = userEvent.setup();
    const { KillConfirmDialog } = KillConfirmDialogModule;
    const wsService = makeWsService();
    (wsService.killSession as ReturnType<typeof vi.fn>).mockRejectedValue('unknown');

    render(
      <WebSocketContext.Provider value={wsService}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

    await typeSessionName(user);
    await user.click(screen.getByRole('button', { name: 'Kill Session' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to kill session')).toBeInTheDocument();
    });
  });

  it('shows "Killing..." loading text during submission', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    // Never resolves so we can observe the loading state
    const killSession = vi.fn().mockImplementation(
      () => new Promise<KillSessionResponse>(() => {}),
    );

    render(
      <WebSocketContext.Provider value={makeWsService({ killSession })}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

    await typeSessionName(userEvent.setup());
    // Use fireEvent for synchronous click — userEvent awaits the handler promise
    fireEvent.click(screen.getByRole('button', { name: 'Kill Session' }));

    await waitFor(() => {
      expect(screen.getByText('Killing...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });
  });

  it('resets error state when dialog is reopened', async () => {
    const user = userEvent.setup();
    const { KillConfirmDialog } = KillConfirmDialogModule;
    const wsService = makeWsService();
    (wsService.killSession as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fail'),
    );

    const { rerender } = render(
      <WebSocketContext.Provider value={wsService}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

    // Trigger error
    await typeSessionName(user);
    await user.click(screen.getByRole('button', { name: 'Kill Session' }));
    await waitFor(() => {
      expect(screen.getByText('fail')).toBeInTheDocument();
    });

    // Close and reopen
    rerender(
      <WebSocketContext.Provider value={wsService}>
        <KillConfirmDialog
          isOpen={false}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );
    rerender(
      <WebSocketContext.Provider value={wsService}>
        <KillConfirmDialog
          isOpen={true}
          onClose={vi.fn()}
          session={makeSession()}
          onKilled={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.queryByText('fail')).not.toBeInTheDocument();
    });
  });

  describe('name confirmation guard', () => {
    function renderDialog(wsService: WebSocketService) {
      return render(
        <WebSocketContext.Provider value={wsService}>
          <KillConfirmDialogModule.KillConfirmDialog
            isOpen={true}
            onClose={vi.fn()}
            session={makeSession()}
            onKilled={vi.fn()}
          />
        </WebSocketContext.Provider>,
      );
    }

    it('disables the kill button until a name is typed', async () => {
      renderDialog(makeWsService());

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Kill Session' })).toBeDisabled();
      });
    });

    it('keeps the kill button disabled for a mismatched name', async () => {
      const user = userEvent.setup();
      renderDialog(makeWsService());

      await typeSessionName(user, 'my-sessio');

      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeDisabled();
      expect(screen.getByText(/doesn't match yet/i)).toBeInTheDocument();
    });

    it('enables the kill button once the name matches exactly', async () => {
      const user = userEvent.setup();
      renderDialog(makeWsService());

      await typeSessionName(user);

      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeEnabled();
      expect(screen.queryByText(/doesn't match yet/i)).not.toBeInTheDocument();
    });

    it('does not call killSession while the name is wrong', async () => {
      const user = userEvent.setup();
      const wsService = makeWsService();
      renderDialog(wsService);

      await typeSessionName(user, 'wrong-name');
      await user.click(screen.getByRole('button', { name: 'Kill Session' }));

      expect(wsService.killSession).not.toHaveBeenCalled();
    });

    it('tolerates surrounding whitespace when matching', async () => {
      const user = userEvent.setup();
      const wsService = makeWsService();
      renderDialog(wsService);

      await typeSessionName(user, '  my-session  ');
      await user.click(screen.getByRole('button', { name: 'Kill Session' }));

      expect(wsService.killSession).toHaveBeenCalledWith('agent-1:my-session');
    });

    it('submits on Enter when the name matches', async () => {
      const user = userEvent.setup();
      const wsService = makeWsService();
      renderDialog(wsService);

      await typeSessionName(user);
      await user.keyboard('{Enter}');

      expect(wsService.killSession).toHaveBeenCalledWith('agent-1:my-session');
    });

    it('ignores Enter when the name does not match', async () => {
      const user = userEvent.setup();
      const wsService = makeWsService();
      renderDialog(wsService);

      await typeSessionName(user, 'nope');
      await user.keyboard('{Enter}');

      expect(wsService.killSession).not.toHaveBeenCalled();
    });

    it('clears the typed name when the dialog is reopened', async () => {
      const user = userEvent.setup();
      const wsService = makeWsService();
      const session = makeSession();
      const { rerender } = render(
        <WebSocketContext.Provider value={wsService}>
          <KillConfirmDialogModule.KillConfirmDialog
            isOpen={true} onClose={vi.fn()} session={session} onKilled={vi.fn()} />
        </WebSocketContext.Provider>,
      );

      await typeSessionName(user);
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeEnabled();

      for (const isOpen of [false, true]) {
        rerender(
          <WebSocketContext.Provider value={wsService}>
            <KillConfirmDialogModule.KillConfirmDialog
              isOpen={isOpen} onClose={vi.fn()} session={session} onKilled={vi.fn()} />
          </WebSocketContext.Provider>,
        );
      }

      // Re-armed: the guard must not carry over from the previous open.
      await waitFor(() => {
        expect(screen.getByRole('textbox')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Kill Session' })).toBeDisabled();
      });
    });
  });
});

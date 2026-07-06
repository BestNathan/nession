import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, KillSessionResponse } from '../../types';
import type { WebSocketService } from '../../services/websocket';

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

describe('KillConfirmDialog', () => {
  it('renders dialog when open', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    render(
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={makeWsService()}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Kill Session' })).toBeInTheDocument();
      expect(screen.getByText(/my-session/)).toBeInTheDocument();
    });
  });

  it('does not render when closed', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    render(
      <KillConfirmDialog
        isOpen={false}
        onClose={vi.fn()}
        wsService={makeWsService()}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    expect(screen.queryByRole('heading', { name: 'Kill Session' })).not.toBeInTheDocument();
  });

  it('does not render when session is null', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    render(
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={makeWsService()}
        session={null}
        onKilled={vi.fn()}
      />,
    );

    expect(screen.queryByRole('heading', { name: 'Kill Session' })).not.toBeInTheDocument();
  });

  it('has Cancel and Kill buttons', async () => {
    const { KillConfirmDialog } = KillConfirmDialogModule;
    render(
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={makeWsService()}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
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
      <KillConfirmDialog
        isOpen={true}
        onClose={onClose}
        wsService={makeWsService()}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
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
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={wsService}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

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
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={wsService}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

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
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={wsService}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

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
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={wsService}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

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
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={makeWsService({ killSession })}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

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
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={wsService}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Kill Session' })).toBeInTheDocument();
    });

    // Trigger error
    await user.click(screen.getByRole('button', { name: 'Kill Session' }));
    await waitFor(() => {
      expect(screen.getByText('fail')).toBeInTheDocument();
    });

    // Close and reopen
    rerender(
      <KillConfirmDialog
        isOpen={false}
        onClose={vi.fn()}
        wsService={wsService}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );
    rerender(
      <KillConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={wsService}
        session={makeSession()}
        onKilled={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('fail')).not.toBeInTheDocument();
    });
  });
});

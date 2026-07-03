import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '../../types';
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

function makeWsService(): WebSocketService {
  return {
    killSession: vi.fn().mockResolvedValue({ success: true }),
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
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent } from '../../types';
import type { WebSocketService } from '../../services/websocket';

// Mock the ui/dialog module to render content directly (no portal)
vi.mock('../ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Now import the component (after the mock is set up)
// We need to dynamically import because the mock must be in place first
let CreateSessionDialogModule: typeof import('../CreateSessionDialog');
beforeEach(async () => {
  CreateSessionDialogModule = await import('../CreateSessionDialog');
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'server-01',
    ip_address: '10.0.0.1',
    port: 8080,
    status: 'online',
    session_count: 0,
    last_heartbeat: new Date().toISOString(),
    ...overrides,
  };
}

function makeWsService(): WebSocketService {
  return {
    createSession: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as WebSocketService;
}

describe('CreateSessionDialog', () => {
  it('renders dialog when open', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;
    render(
      <CreateSessionDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={makeWsService()}
        agents={[makeAgent()]}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Create Session')).toBeInTheDocument();
    });
  });

  it('does not render when closed', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;
    render(
      <CreateSessionDialog
        isOpen={false}
        onClose={vi.fn()}
        wsService={makeWsService()}
        agents={[makeAgent()]}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.queryByText('Create Session')).not.toBeInTheDocument();
  });

  it('has Cancel and Create buttons', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;
    render(
      <CreateSessionDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={makeWsService()}
        agents={[makeAgent()]}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    });
  });

  it('has session name input', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;
    render(
      <CreateSessionDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={makeWsService()}
        agents={[makeAgent()]}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('my-session')).toBeInTheDocument();
    });
  });

  it('calls onClose when Cancel clicked', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const onClose = vi.fn();

    render(
      <CreateSessionDialog
        isOpen={true}
        onClose={onClose}
        wsService={makeWsService()}
        agents={[makeAgent()]}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('disables Create button when no online agents', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;

    render(
      <CreateSessionDialog
        isOpen={true}
        onClose={vi.fn()}
        wsService={makeWsService()}
        agents={[makeAgent({ status: 'offline' })]}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    });
  });
});

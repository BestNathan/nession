import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent, CreateSessionResponse } from '@/types';
import type { WebSocketService } from '@/services/websocket';
import { WebSocketContext } from '@/hooks/useWebSocket';

// Mock the ui/dialog module to render content directly (no portal)
vi.mock( '@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Now import the component (after the mock is set up)
// We need to dynamically import because the mock must be in place first
let CreateSessionDialogModule: typeof import('@/components/CreateSessionDialog');
beforeEach(async () => {
  CreateSessionDialogModule = await import('@/components/CreateSessionDialog');
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

function makeWsService(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    createSession: vi.fn().mockResolvedValue({ success: true }),
    listEnvFiles: vi.fn().mockResolvedValue({ files: [] }),
    ...overrides,
  } as unknown as WebSocketService;
}

describe('CreateSessionDialog', () => {
  // ── Rendering ─────────────────────────────────────────────────────────

  it('renders dialog when open', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;
    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Create Session')).toBeInTheDocument();
    });
  });

  it('does not render when closed', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;
    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <CreateSessionDialog
          isOpen={false}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    expect(screen.queryByText('Create Session')).not.toBeInTheDocument();
  });

  it('has Cancel and Create buttons', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;
    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    });
  });

  it('has session name input', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;
    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
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
      <WebSocketContext.Provider value={makeWsService()}>
        <CreateSessionDialog
          isOpen={true}
          onClose={onClose}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
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
      <WebSocketContext.Provider value={makeWsService()}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent({ status: 'offline' })]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    });
  });

  // ── Form submission: success ──────────────────────────────────────────

  it('creates session successfully and calls onCreated + onClose', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const createSession = vi.fn().mockResolvedValue({ success: true, session_id: 'agent-1:my-session' });

    render(
      <WebSocketContext.Provider value={makeWsService({ createSession })}>
        <CreateSessionDialog
          isOpen={true}
          onClose={onClose}
          agents={[makeAgent()]}
          onCreated={onCreated}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('my-session')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('my-session'), 'my-session');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('agent-1', 'my-session', []);
      expect(onCreated).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ── Form submission: failure ──────────────────────────────────────────

  it('shows error when createSession returns success=false', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const createSession = vi.fn().mockResolvedValue({
      success: false,
      error: 'Agent is offline',
    });

    render(
      <WebSocketContext.Provider value={makeWsService({ createSession })}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('my-session')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('my-session'), 'test');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('Agent is offline')).toBeInTheDocument();
    });
  });

  it('shows error when createSession throws', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const createSession = vi.fn().mockRejectedValue(new Error('Network error'));

    render(
      <WebSocketContext.Provider value={makeWsService({ createSession })}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('my-session')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('my-session'), 'test');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('shows generic error when createSession throws non-Error', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const createSession = vi.fn().mockRejectedValue('unknown');

    render(
      <WebSocketContext.Provider value={makeWsService({ createSession })}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('my-session')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('my-session'), 'test');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to create session')).toBeInTheDocument();
    });
  });

  // ── Validation ────────────────────────────────────────────────────────

  it('shows error for empty session name', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const createSession = vi.fn();

    render(
      <WebSocketContext.Provider value={makeWsService({ createSession })}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('Session name is required')).toBeInTheDocument();
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('shows error for invalid session name characters', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const createSession = vi.fn();

    render(
      <WebSocketContext.Provider value={makeWsService({ createSession })}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('my-session')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('my-session'), 'bad name!');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText(/Only letters, digits/)).toBeInTheDocument();
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('accepts session name with hyphens and dots', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const createSession = vi.fn().mockResolvedValue({ success: true });

    render(
      <WebSocketContext.Provider value={makeWsService({ createSession })}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('my-session')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('my-session'), 'my-app.v2');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('agent-1', 'my-app.v2', []);
    });
  });

  // ── Loading state ─────────────────────────────────────────────────────

  it('shows "Creating..." and disables buttons during submission', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    // Never resolves so we can inspect the loading state
    const createSession = vi.fn().mockImplementation(
      () => new Promise<CreateSessionResponse>(() => {}),
    );

    render(
      <WebSocketContext.Provider value={makeWsService({ createSession })}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText('my-session')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('my-session'), 'test');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('Creating...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });
  });

  // ── preselectedAgentId ────────────────────────────────────────────────

  it('preselects agent when preselectedAgentId is provided', async () => {
    const { CreateSessionDialog } = CreateSessionDialogModule;

    render(
      <WebSocketContext.Provider value={makeWsService()}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent({ agent_id: 'agent-1' }), makeAgent({ agent_id: 'agent-2' })]}
          preselectedAgentId="agent-2"
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      // The Create button should be enabled because agent-2 is online
      expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
    });
  });

  // ── State reset on reopen ─────────────────────────────────────────────

  it('resets error state when dialog is reopened', async () => {
    const user = userEvent.setup();
    const { CreateSessionDialog } = CreateSessionDialogModule;
    const ws = makeWsService();

    const { rerender } = render(
      <WebSocketContext.Provider value={ws}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
    });

    // Trigger validation error
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(screen.getByText('Session name is required')).toBeInTheDocument();
    });

    // Close and reopen
    rerender(
      <WebSocketContext.Provider value={ws}>
        <CreateSessionDialog
          isOpen={false}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );
    rerender(
      <WebSocketContext.Provider value={ws}>
        <CreateSessionDialog
          isOpen={true}
          onClose={vi.fn()}
          agents={[makeAgent()]}
          onCreated={vi.fn()}
        />
      </WebSocketContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.queryByText('Session name is required')).not.toBeInTheDocument();
    });
  });
});

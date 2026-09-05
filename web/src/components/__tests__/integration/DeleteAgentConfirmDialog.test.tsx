import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Agent } from '@/types';

// The dialog talks to the agentsApi singleton — no WebSocketService involved.
const { deleteAgentMock } = vi.hoisted(() => ({
  deleteAgentMock: vi.fn(),
}));
vi.mock('@/features/agents', () => ({
  agentsApi: { deleteAgent: deleteAgentMock },
}));

// Mock AlertDialog to render children directly (no portal)
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({ children, onClick, disabled, className }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) => (
    <button onClick={onClick} disabled={disabled} className={className}>{children}</button>
  ),
  AlertDialogCancel: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

let DeleteModule: typeof import('@/components/DeleteAgentConfirmDialog');
beforeEach(async () => {
  DeleteModule = await import('@/components/DeleteAgentConfirmDialog');
  deleteAgentMock.mockReset();
  deleteAgentMock.mockResolvedValue(undefined);
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-1',
    hostname: 'node-1.local',
    ip_address: '10.0.0.1',
    port: 19090,
    status: 'offline',
    session_count: 3,
    last_heartbeat: new Date().toISOString(),
    registered_at: new Date().toISOString(),
    display_name: 'My Agent',
    metadata: { nession_version: '0.30.0', tmux_version: '3.4', os_version: 'Linux' },
    addresses: [],
    active_sessions: 0,
    ...overrides,
  };
}

async function typeName(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.clear(screen.getByRole('textbox'));
  await user.type(screen.getByRole('textbox'), name);
}

describe('DeleteAgentConfirmDialog', () => {
  it('renders dialog with both names when open', async () => {
    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        agent={makeAgent()}
        onDeleted={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Delete Agent' })).toBeInTheDocument();
      expect(screen.getAllByText('My Agent').length).toBeGreaterThan(0);
      expect(screen.getAllByText('node-1.local').length).toBeGreaterThan(0);
    });
  });

  it('does not render when agent is null', () => {
    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        agent={null}
        onDeleted={vi.fn()}
      />,
    );

    expect(screen.queryByRole('heading', { name: 'Delete Agent' })).not.toBeInTheDocument();
  });

  it('disables delete button until a matching name is typed', async () => {
    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        agent={makeAgent()}
        onDeleted={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete Agent' })).toBeDisabled();
    });
  });

  it('enables delete button when display name is typed', async () => {
    const user = userEvent.setup();
    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        agent={makeAgent()}
        onDeleted={vi.fn()}
      />,
    );

    await typeName(user, 'My Agent');
    expect(screen.getByRole('button', { name: 'Delete Agent' })).toBeEnabled();
  });

  it('enables delete button when hostname is typed', async () => {
    const user = userEvent.setup();
    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        agent={makeAgent()}
        onDeleted={vi.fn()}
      />,
    );

    await typeName(user, 'node-1.local');
    expect(screen.getByRole('button', { name: 'Delete Agent' })).toBeEnabled();
  });

  it('keeps button disabled for a mismatched name', async () => {
    const user = userEvent.setup();
    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        agent={makeAgent()}
        onDeleted={vi.fn()}
      />,
    );

    await typeName(user, 'wrong-name');
    expect(screen.getByRole('button', { name: 'Delete Agent' })).toBeDisabled();
    expect(screen.getByText(/doesn't match yet/i)).toBeInTheDocument();
  });

  it('calls deleteAgent on confirm', async () => {
    const user = userEvent.setup();

    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        agent={makeAgent()}
        onDeleted={vi.fn()}
      />,
    );

    await typeName(user, 'My Agent');
    await user.click(screen.getByRole('button', { name: 'Delete Agent' }));
    expect(deleteAgentMock).toHaveBeenCalledWith('agent-1');
  });

  it('shows error when deleteAgent throws', async () => {
    const user = userEvent.setup();
    deleteAgentMock.mockRejectedValue(new Error('Agent is online'));

    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={vi.fn()}
        agent={makeAgent()}
        onDeleted={vi.fn()}
      />,
    );

    await typeName(user, 'My Agent');
    await user.click(screen.getByRole('button', { name: 'Delete Agent' }));

    await waitFor(() => {
      expect(screen.getByText('Agent is online')).toBeInTheDocument();
    });
  });

  it('calls onDeleted and onClose on success', async () => {
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    const onClose = vi.fn();

    render(
      <DeleteModule.DeleteAgentConfirmDialog
        isOpen={true}
        onClose={onClose}
        agent={makeAgent()}
        onDeleted={onDeleted}
      />,
    );

    await typeName(user, 'My Agent');
    await user.click(screen.getByRole('button', { name: 'Delete Agent' }));

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });
});

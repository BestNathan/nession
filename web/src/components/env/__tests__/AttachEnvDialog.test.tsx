import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttachEnvDialog } from '../AttachEnvDialog';
import type { WebSocketService } from '../../../services/websocket';
import type { Session } from '../../../types';

function session(): Session {
  return {
    session_id: 'agent-1:dev',
    agent_id: 'agent-1',
    session_name: 'dev',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: new Date().toISOString(),
  };
}

function makeWs(overrides: Partial<WebSocketService> = {}): WebSocketService {
  return {
    listEnvFiles: vi
      .fn()
      .mockResolvedValue({ files: [{ name: 'a.env', source: 'server', size: 3, modified: 0, var_count: 1 }] }),
    ...overrides,
  } as unknown as WebSocketService;
}

describe('AttachEnvDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('confirms with selected env files', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachEnvDialog
        isOpen
        onClose={vi.fn()}
        wsService={makeWs()}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    await waitFor(() => expect(screen.getByText('a.env')).toBeInTheDocument());
    await user.click(screen.getByText('a.env'));
    await user.click(screen.getByRole('button', { name: /Attach with 1/ }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'agent-1:dev' }),
      [{ name: 'a.env', source: 'server', agent_id: undefined }],
    );
  });

  it('confirms with no env files (plain attach)', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachEnvDialog
        isOpen
        onClose={vi.fn()}
        wsService={makeWs()}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    await waitFor(() => expect(screen.getByText('a.env')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Attach$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.anything(), []);
  });
});

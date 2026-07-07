import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttachDialog } from '../AttachDialog';
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

describe('AttachDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('defaults to Auto mode and confirms with no env', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} wsService={makeWs()} session={session()} onConfirm={onConfirm} />,
    );
    await waitFor(() => expect(screen.getByText('a.env')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /^Attach$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'agent-1:dev' }), 'auto', []);
  });

  it('selects P2P mode and an env file', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} wsService={makeWs()} session={session()} onConfirm={onConfirm} />,
    );
    await waitFor(() => expect(screen.getByText('a.env')).toBeInTheDocument());
    // The P2P mode button contains a bold "P2P" label span.
    await user.click(screen.getByText('P2P'));
    await user.click(screen.getByText('a.env'));
    await user.click(screen.getByRole('button', { name: /Attach with 1/ }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'agent-1:dev' }),
      'p2p',
      [{ name: 'a.env', source: 'server', agent_id: undefined }],
    );
  });

  it('does not offer a forced Relay mode', async () => {
    render(
      <AttachDialog isOpen onClose={vi.fn()} wsService={makeWs()} session={session()} onConfirm={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('a.env')).toBeInTheDocument());
    // Only Auto and P2P mode labels are present; no standalone "Relay" label.
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('P2P')).toBeInTheDocument();
    expect(screen.queryByText('Relay')).not.toBeInTheDocument();
  });

  it('pre-fills from saved preferences', async () => {
    localStorage.setItem(
      'nession_attach_prefs',
      JSON.stringify({ mode: 'p2p', envFiles: [] }),
    );
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} wsService={makeWs()} session={session()} onConfirm={onConfirm} />,
    );
    await waitFor(() => expect(screen.getByText('a.env')).toBeInTheDocument());
    // Mode P2P is preselected; confirming yields p2p without touching the buttons.
    await user.click(screen.getByRole('button', { name: /^Attach$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.anything(), 'p2p', []);
  });
});

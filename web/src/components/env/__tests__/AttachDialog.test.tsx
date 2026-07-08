import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttachDialog } from '../AttachDialog';
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

describe('AttachDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('defaults to Auto mode and confirms', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirm} />,
    );
    await user.click(screen.getByRole('button', { name: /^Attach$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'agent-1:dev' }), 'auto');
  });

  it('selects P2P mode', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirm} />,
    );
    await user.click(screen.getByText('P2P'));
    await user.click(screen.getByRole('button', { name: /^Attach$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.anything(), 'p2p');
  });

  it('does not offer a forced Relay mode', () => {
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('P2P')).toBeInTheDocument();
    expect(screen.queryByText('Relay')).not.toBeInTheDocument();
  });

  it('pre-fills from saved preferences', async () => {
    localStorage.setItem('nession_attach_prefs', JSON.stringify({ mode: 'p2p' }));
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirm} />,
    );
    await user.click(screen.getByRole('button', { name: /^Attach$/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.anything(), 'p2p');
  });
});

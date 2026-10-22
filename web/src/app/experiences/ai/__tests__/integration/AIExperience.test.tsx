import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AIExperience } from '@/app/experiences/ai/AIExperience';
import type { Agent, Session } from '@/types';

const agent = {
  agent_id: 'a1', hostname: 'devbox', display_name: 'Devbox', status: 'online',
  session_count: 1, ip_address: '127.0.0.1', port: 1234, last_heartbeat: '',
} as Agent;
const session = {
  agent_id: 'a1', session_id: 'a1:work', session_name: 'work', status: 'active',
  window_count: 1, attached_clients: 0, last_activity: '',
} as Session;

describe('AIExperience', () => {
  it('starts quiet, reveals the live Agent list and routes row actions to the canonical Create dialog', async () => {
    const onCreateSession = vi.fn();
    render(<AIExperience agents={[agent]} sessions={[session]} onCreateSession={onCreateSession} onOpenSession={vi.fn()} />);
    expect(screen.queryByTestId('ai-agent-list')).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: 'Nession command' }), '查看节点列表');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByTestId('ai-agent-list')).toHaveTextContent('Devbox');

    await userEvent.click(screen.getByRole('button', { name: 'Create Session on Devbox' }));
    expect(onCreateSession).toHaveBeenCalledWith('a1');
  });

  it('shows Session rows and opens them through Shell, not a second Terminal runtime', async () => {
    const onOpenSession = vi.fn();
    render(<AIExperience agents={[agent]} sessions={[session]} onCreateSession={vi.fn()} onOpenSession={onOpenSession} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Nession command' }), '看看 session 列表');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open Session work' }));
    expect(onOpenSession).toHaveBeenCalledWith(session);
  });

  it('does not execute unsupported requests', async () => {
    const onCreateSession = vi.fn();
    const onOpenSession = vi.fn();
    render(<AIExperience agents={[agent]} sessions={[session]} onCreateSession={onCreateSession} onOpenSession={onOpenSession} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Nession command' }), 'delete every node');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText(/No action was performed/)).toBeInTheDocument();
    expect(onCreateSession).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});

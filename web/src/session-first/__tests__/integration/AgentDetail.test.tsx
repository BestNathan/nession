import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderSlot } from '@/extensions/registry';
import { AgentDetail } from '@/session-first/patterns/AgentDetail';
import { SessionDetails } from '@/session-first/SessionDetails';
import claudeCodeExtension from '@/extensions/claude-code';
import type { Agent, Session } from '@/types';
import type { DomainState } from '@/session-first/domainState';

vi.mock('@/extensions/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/extensions/registry')>();
  return {
    ...actual,
    renderSlot: vi.fn(actual.renderSlot),
  };
});

const state: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};

describe('AgentDetail', () => {
  beforeEach(() => {
    vi.mocked(renderSlot).mockClear();
    vi.mocked(renderSlot).mockReturnValue([]);
  });

  it('AgentDetail is not AgentDetailPanel', () => {
    const agent: Agent = {
      agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
      ip_address: '10.0.0.1', port: 19091, status: 'online', session_count: 1,
      last_heartbeat: '2026-01-01T00:00:00Z',
    };
    render(<AgentDetail agent={agent} state={state} />);
    expect(screen.getByTestId('agent-detail')).toHaveTextContent('devbox-01');
    expect(screen.getByTestId('channel-agent')).toBeInTheDocument();
    expect(screen.queryByText(/Copy Agent details/i)).not.toBeInTheDocument();
    expect(renderSlot).toHaveBeenCalledWith('agent-detail', { agent });
  });

  it('renders a generic agent-detail extension slot', () => {
    const agent: Agent = {
      agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
      ip_address: '10.0.0.1', port: 19091, status: 'online', session_count: 1,
      last_heartbeat: '2026-01-01T00:00:00Z',
    };
    vi.mocked(renderSlot).mockReturnValue([
      <div key="other-extension" data-testid="other-extension">Other extension</div>,
    ]);

    render(<AgentDetail agent={agent} state={state} />);

    expect(renderSlot).toHaveBeenCalledWith('agent-detail', { agent });
    expect(screen.getByTestId('agent-detail-extensions')).toBeInTheDocument();
    expect(screen.getByTestId('other-extension')).toBeInTheDocument();
  });

  it('does not render Claude Code from the default extension entry', () => {
    const agent: Agent = {
      agent_id: 'a1', hostname: 'devbox-01', display_name: 'devbox-01',
      ip_address: '10.0.0.1', port: 19091, status: 'online', session_count: 1,
      last_heartbeat: '2026-01-01T00:00:00Z',
      metadata: {
        tmux_version: '3.4',
        os_version: 'linux',
        nession_version: '0.30.0',
      },
    };

    render(<AgentDetail agent={agent} state={state} />);

    expect(claudeCodeExtension.slots['agent-detail']).toBeUndefined();
    expect(renderSlot).toHaveBeenCalledWith('agent-detail', { agent });
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });
});

describe('SessionDetails', () => {
  it('shows facts', () => {
    const session: Session = {
      session_id: 'a1:s1', agent_id: 'a1', session_name: 's1', status: 'active',
      window_count: 2, attached_clients: 0, last_activity: '2026-01-01T00:00:00Z',
    };
    render(<SessionDetails session={session} state={state} />);
    expect(screen.getByText('s1')).toBeInTheDocument();
    expect(screen.getByText('a1:s1')).toBeInTheDocument();
  });
});

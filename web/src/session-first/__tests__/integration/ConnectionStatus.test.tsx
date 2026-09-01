import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConnectionStatus } from '@/session-first/patterns/ConnectionStatus';
import type { DomainState } from '@/session-first/domainState';

const state: DomainState = {
  agent: { channel: 'offline', copy: 'Agent offline' },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'failed', copy: 'Attach failed' },
};

describe('ConnectionStatus', () => {
  it('renders the three channel values and does not say Session offline', () => {
    render(<ConnectionStatus state={state} />);
    expect(screen.getByTestId('connection-status')).toBeInTheDocument();
    expect(screen.getByTestId('channel-agent')).toHaveTextContent('offline');
    expect(screen.getByTestId('channel-session')).toHaveTextContent('active');
    expect(screen.getByTestId('channel-attachment')).toHaveTextContent('Attach failed');
    expect(screen.queryByText(/Session offline/i)).not.toBeInTheDocument();
  });
});

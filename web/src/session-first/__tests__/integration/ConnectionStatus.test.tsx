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
  it('renders three labeled channels and does not say Session offline', () => {
    render(<ConnectionStatus state={state} />);
    expect(screen.getByTestId('channel-agent')).toHaveTextContent(/Agent/);
    expect(screen.getByTestId('channel-agent')).toHaveTextContent(/offline/i);
    expect(screen.getByTestId('channel-session')).toHaveTextContent(/Session/);
    expect(screen.getByTestId('channel-attachment')).toHaveTextContent(/Attach failed/);
    expect(screen.queryByText(/Session offline/i)).not.toBeInTheDocument();
  });
});

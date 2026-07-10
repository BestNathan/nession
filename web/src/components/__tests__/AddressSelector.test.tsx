import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AddressSelector } from '../AddressSelector';
import type { ProbedAddress } from '../../types';

function probed(url: string, label: string, status: ProbedAddress['status'] = 'reachable'): ProbedAddress {
  return { url, label, network_type: 'lan', priority: 10, status };
}

describe('AddressSelector', () => {
  it('renders nothing when there is at most one address', () => {
    const { container } = render(
      <AddressSelector
        addresses={[probed('ws://a/ws', 'LAN')]}
        latencies={[]}
        activeUrl="ws://a/ws"
        isAuto
        onSelect={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the route trigger when multiple addresses exist', () => {
    render(
      <AddressSelector
        addresses={[probed('ws://a/ws', 'LAN'), probed('ws://b/ws', 'VPN')]}
        latencies={[{ url: 'ws://a/ws', latencyMs: 12 }, { url: 'ws://b/ws', latencyMs: null }]}
        activeUrl="ws://a/ws"
        isAuto
        onSelect={vi.fn()}
      />,
    );
    // Trigger renders the "Route:" prefix and is labelled for a11y.
    expect(screen.getByText('Route:')).toBeInTheDocument();
    expect(screen.getByLabelText('P2P route')).toBeInTheDocument();
  });
});

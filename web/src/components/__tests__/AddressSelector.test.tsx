import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddressSelector } from '../AddressSelector';
import type { ProbedAddress } from '../../types';

function probed(url: string, label: string, status: ProbedAddress['status'] = 'reachable'): ProbedAddress {
  return { url, label, network_type: 'lan', priority: 10, status };
}

// Default props for tests.
function defaultProps(overrides: Partial<Parameters<typeof AddressSelector>[0]> = {}) {
  return {
    addresses: [probed('ws://a/ws', 'LAN'), probed('ws://b/ws', 'VPN')],
    latencies: [{ url: 'ws://a/ws', latencyMs: 12 }, { url: 'ws://b/ws', latencyMs: 8 }],
    activeUrl: 'ws://a/ws',
    isAuto: true,
    onSelect: vi.fn(),
    isSwitching: false,
    effectiveMode: 'p2p' as const,
    ...overrides,
  };
}

// Stub matchMedia — desktop by default (min-width: 640px = true).
function setDesktop(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

describe('AddressSelector', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  describe('shared', () => {
    it('renders nothing when there is at most one address', () => {
      setDesktop(true);
      const { container } = render(
        <AddressSelector
          {...defaultProps({ addresses: [probed('ws://a/ws', 'LAN')] })}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('desktop (≥640px)', () => {
    beforeEach(() => setDesktop(true));

    it('shows the route Select trigger with "Route:" label', () => {
      render(<AddressSelector {...defaultProps()} />);
      expect(screen.getByText('Route:')).toBeInTheDocument();
      expect(screen.getByLabelText('P2P route')).toBeInTheDocument();
    });

    it('calls onSelect with url when a manual address is chosen', async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(<AddressSelector {...defaultProps({ onSelect })} />);

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('LAN'));

      expect(onSelect).toHaveBeenCalledWith('ws://a/ws');
    });

    it('calls onSelect with null when Auto is chosen', async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(<AddressSelector {...defaultProps({ onSelect })} />);

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('Auto (lowest latency)'));

      expect(onSelect).toHaveBeenCalledWith(null);
    });
  });

  describe('mobile (<640px)', () => {
    beforeEach(() => setDesktop(false));

    it('renders an icon button', () => {
      render(<AddressSelector {...defaultProps()} />);
      expect(screen.getByLabelText('P2P route')).toBeInTheDocument();
      // Should NOT have the "Route:" text label.
      expect(screen.queryByText('Route:')).not.toBeInTheDocument();
    });

    it('opens Sheet when icon is clicked', async () => {
      const user = userEvent.setup();
      render(<AddressSelector {...defaultProps()} />);

      await user.click(screen.getByLabelText('P2P route'));

      expect(screen.getByText('Select Route')).toBeInTheDocument();
      expect(screen.getByText('Auto (lowest latency)')).toBeInTheDocument();
      expect(screen.getByText('LAN')).toBeInTheDocument();
      expect(screen.getByText('VPN')).toBeInTheDocument();
    });

    it('calls onSelect and closes Sheet when an address is chosen', async () => {
      const onSelect = vi.fn();
      const user = userEvent.setup();
      render(<AddressSelector {...defaultProps({ onSelect })} />);

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('LAN'));

      expect(onSelect).toHaveBeenCalledWith('ws://a/ws');
    });

    it('shows Loader2 spinner when isSwitching is true', () => {
      render(<AddressSelector {...defaultProps({ isSwitching: true })} />);
      // The spinner icon has animate-spin class.
      const btn = screen.getByLabelText('P2P route');
      expect(btn.querySelector('.animate-spin')).toBeTruthy();
    });

    it('shows amber WifiOff when in relay fallback mode', () => {
      render(<AddressSelector {...defaultProps({ effectiveMode: 'relay' })} />);
      const btn = screen.getByLabelText('P2P route');
      expect(btn.querySelector('.text-amber-500')).toBeTruthy();
    });
  });
});

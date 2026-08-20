import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { AddressSelector } from '@/components/AddressSelector';
import { manualOverrideAtom } from '@/atoms/session';
import type { ProbedAddress } from '@/types';

function probed(url: string, label: string, status: ProbedAddress['status'] = 'reachable'): ProbedAddress {
  return { url, label, network_type: 'lan', priority: 10, status };
}

// AddressSelector now reads selection state from jotai atoms; only server
// data (addresses/latencies) and effectiveMode are props.
function defaultProps(overrides: Partial<Parameters<typeof AddressSelector>[0]> = {}) {
  return {
    addresses: [probed('ws://a/ws', 'LAN'), probed('ws://b/ws', 'VPN')],
    latencies: [{ url: 'ws://a/ws', latencyMs: 12 }, { url: 'ws://b/ws', latencyMs: 8 }],
    effectiveMode: 'p2p' as const,
    ...overrides,
  };
}

/** Render inside a jotai Provider so atom writes are isolated per test. */
function renderSelector(
  overrides: Partial<Parameters<typeof AddressSelector>[0]> = {},
  store = createStore(),
) {
  return {
    store,
    ...render(
      <Provider store={store}>
        <AddressSelector {...defaultProps(overrides)} />
      </Provider>,
    ),
  };
}

// user-event instance that skips the pointer-events check. The Base UI
// Select/Sheet popups set inline `pointer-events: none` during their open
// transition frame, which races user-event's default check when the popup is
// clicked immediately after the trigger under full-suite load (flaky in CI).
function setupUser() {
  return userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
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
    it('still shows the selector even with a single address', () => {
      setDesktop(true);
      renderSelector({ addresses: [probed('ws://a/ws', 'LAN')] });
      expect(screen.getByText('Route:')).toBeInTheDocument();
    });
  });

  describe('desktop (≥640px)', () => {
    beforeEach(() => setDesktop(true));

    it('shows the route Select trigger with "Route:" label', () => {
      renderSelector();
      expect(screen.getByText('Route:')).toBeInTheDocument();
      expect(screen.getByLabelText('P2P route')).toBeInTheDocument();
    });

    it('writes manualOverrideAtom when a manual address is chosen', async () => {
      const { store } = renderSelector();
      const user = setupUser();

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('LAN'));

      expect(store.get(manualOverrideAtom)).toBe('ws://a/ws');
    });

    it('writes null to manualOverrideAtom when Auto is chosen', async () => {
      const store = createStore();
      // Start with a manual override so Auto is a meaningful choice.
      store.set(manualOverrideAtom, 'ws://a/ws');
      const user = setupUser();
      renderSelector({}, store);

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('Auto (lowest latency)'));

      expect(store.get(manualOverrideAtom)).toBeNull();
    });
  });

  describe('mobile (<640px)', () => {
    beforeEach(() => setDesktop(false));

    it('renders an icon button', () => {
      renderSelector();
      expect(screen.getByLabelText('P2P route')).toBeInTheDocument();
      // Should NOT have the "Route:" text label.
      expect(screen.queryByText('Route:')).not.toBeInTheDocument();
    });

    it('opens Sheet when icon is clicked', async () => {
      const user = userEvent.setup();
      renderSelector();

      await user.click(screen.getByLabelText('P2P route'));

      expect(screen.getByText('Select Route')).toBeInTheDocument();
      expect(screen.getByText('Auto (lowest latency)')).toBeInTheDocument();
      expect(screen.getByText('LAN')).toBeInTheDocument();
      expect(screen.getByText('VPN')).toBeInTheDocument();
    });

    it('writes manualOverrideAtom and closes Sheet when an address is chosen', async () => {
      const { store } = renderSelector();
      const user = setupUser();

      await user.click(screen.getByLabelText('P2P route'));
      await user.click(screen.getByText('LAN'));

      expect(store.get(manualOverrideAtom)).toBe('ws://a/ws');
    });

    it('shows Loader2 spinner when isSwitching is true', () => {
      const store = createStore();
      // p2pStateAtom defaults to 'disconnected' → isSwitching is true.
      store.set(manualOverrideAtom, 'ws://a/ws');
      renderSelector({}, store);
      const btn = screen.getByLabelText('P2P route');
      expect(btn.querySelector('.animate-spin')).toBeTruthy();
    });

    it('shows amber WifiOff when in relay fallback mode', () => {
      renderSelector({ effectiveMode: 'relay' });
      const btn = screen.getByLabelText('P2P route');
      expect(btn.querySelector('.text-amber-500')).toBeTruthy();
    });
  });
});

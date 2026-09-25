import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TerminalKeysProjection } from '@/product/terminal/TerminalKeysProjection';

function renderKeys(disabled = false) {
  const sendText = vi.fn();
  render(<TerminalKeysProjection sendText={sendText} disabled={disabled} />);
  return { sendText };
}

describe('Terminal Keys accessory', () => {
  it('puts function and combination keys left, directionals right (#826 §7)', () => {
    renderKeys();

    const functions = screen.getByTestId('phys-key-grid');
    const arrows = screen.getByTestId('arrow-key-grid');

    for (const label of ['Esc', 'Tab', 'Shift', 'Space', 'Enter', 'Del']) {
      expect(functions).toContainElement(screen.getByTestId(`phys-key-${label}`));
    }
    for (const label of ['↑', '←', '↓', '→']) {
      expect(arrows).toContainElement(screen.getByTestId(`phys-key-${label}`));
    }
  });

  it('sends a key to the terminal', async () => {
    const { sendText } = renderKeys();

    await userEvent.click(screen.getByTestId('phys-key-Esc'));

    expect(sendText).toHaveBeenCalledWith('\x1b');
  });

  it('sends repeatedly without closing', async () => {
    // §7: "opened then the intent composer still exists and keys can be sent
    // repeatedly". The accessory owns no open/closed state, so nothing here can
    // close it on input — this is the assertion that keeps it that way.
    const { sendText } = renderKeys();

    await userEvent.click(screen.getByTestId('phys-key-Esc'));
    await userEvent.click(screen.getByTestId('phys-key-Tab'));
    await userEvent.click(screen.getByTestId('phys-key-Esc'));

    expect(sendText).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('terminal-keys-body')).toBeInTheDocument();
  });

  it('keeps tapping through a combination and a directional key', async () => {
    // The same §7 sentence, at the strength the criterion asks for: a tap, a
    // *combination* built by holding a modifier, then a directional key — with
    // the accessory asserted after each one.
    //
    // Two claims, and the case fails if either breaks. Presence is
    // `getByTestId`, which throws when the accessory is gone; *identity* is
    // `toBe`, because a re-render that replaced the subtree would leave a node
    // matching the test id while having thrown away everything the user had in
    // flight — the chain included. So the element captured before the first tap
    // is the one that has to still be there after the last.
    const { sendText } = renderKeys();

    const body = screen.getByTestId('terminal-keys-body');
    const row = screen.getByTestId('phys-key-row');

    await userEvent.click(screen.getByTestId('phys-key-Esc'));
    expect(sendText).toHaveBeenNthCalledWith(1, '\x1b');
    expect(screen.getByTestId('terminal-keys-body')).toBe(body);

    // A modifier combination, through the chord that makes one reachable from a
    // touch keyboard: holding Shift starts a chain, tapping Del adds the key it
    // modifies, and sending the chain produces Del's own sequence — a modifier
    // in this row carries no bytes of its own.
    const shift = screen.getByTestId('phys-key-Shift');
    await userEvent.pointer({ target: shift, keys: '[MouseLeft>]' });
    await waitFor(() => {
      expect(screen.getByTestId('capsule-chain-bar')).toBeInTheDocument();
    });
    await userEvent.pointer({ target: shift, keys: '[/MouseLeft]' });
    await userEvent.click(screen.getByTestId('phys-key-Del'));
    await userEvent.click(
      within(screen.getByTestId('capsule-chain-bar')).getByRole('button', { name: 'Send' }),
    );
    expect(sendText).toHaveBeenNthCalledWith(2, '\x1b[3~');
    expect(screen.getByTestId('terminal-keys-body')).toBe(body);

    await userEvent.click(screen.getByTestId('phys-key-↑'));
    expect(sendText).toHaveBeenNthCalledWith(3, '\x1b[A');

    // Three taps, three sends — so the presence above cannot be passing because
    // the taps did nothing at all — over one accessory that never re-mounted.
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('terminal-keys-body')).toBe(body);
    expect(screen.getByTestId('phys-key-row')).toBe(row);
  });

  it('offers no dismiss control of its own', () => {
    // The frame owns dismissal — one control for every capability. The
    // accessory adding a second would give Terminal Keys a way out that Git and
    // Claude Code do not have.
    renderKeys();

    expect(screen.queryByTestId('capsule-capability-dismiss')).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss|close/i })).toBeNull();
  });

  it('sends nothing while the terminal is unavailable', async () => {
    const { sendText } = renderKeys(true);

    await userEvent.click(screen.getByTestId('phys-key-Esc'));

    expect(sendText).not.toHaveBeenCalled();
  });
});

import { render, screen } from '@testing-library/react';
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

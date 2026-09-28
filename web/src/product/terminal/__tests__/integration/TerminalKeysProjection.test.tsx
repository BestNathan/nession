import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TerminalKeysProjection } from '@/product/terminal/TerminalKeysProjection';
import { CHAIN_LONG_PRESS_MS } from '@/product/terminal/capsule/physKeys';

function renderKeys(disabled = false) {
  const sendText = vi.fn();
  render(
    <TerminalKeysProjection
      sendSeq={sendText}
      sendPhysKey={(key) => {
        if (key.semanticKey) {
          sendText(`semantic:${key.semanticKey}`);
        } else {
          sendText(key.seq);
        }
      }}
      disabled={disabled}
    />,
  );
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

    // Through the semantic layer, not as a raw byte. Every key in this row that
    // *has* a semantic form now goes that way (#1096 criterion 4), which is
    // what stops this module — a UI module — from owning the sequence. The
    // helper below is the seam: it renders a semantic key as `semantic:<name>`,
    // so this assertion fails if the row starts sending `'\x1b'` itself again.
    expect(sendText).toHaveBeenCalledWith('semantic:Escape');
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
    expect(sendText).toHaveBeenNthCalledWith(1, 'semantic:Escape');
    expect(screen.getByTestId('terminal-keys-body')).toBe(body);

    // A modifier combination, through the chord that makes one reachable from a
    // touch keyboard: holding Shift starts a chain, tapping Del adds the key it
    // modifies, and sending the chain produces Del — through the **same**
    // semantic seam a tap uses. The chain used to concatenate raw bytes, which
    // meant a chained cursor key carried whichever sequence was written into
    // the table rather than the one the terminal's mode asks for (#1096
    // criterion 4). A modifier in this row carries no bytes of its own.
    const shift = screen.getByTestId('phys-key-Shift');
    await userEvent.pointer({ target: shift, keys: '[MouseLeft>]' });
    await waitFor(() => {
      expect(screen.getByTestId('capsule-chain-bar')).toBeInTheDocument();
    });
    // The strip names the key. It used to render the key's *sequence* through a
    // table that mapped escapes back to names — and `Shift` has no sequence,
    // because it sends nothing, so the strip read `\xNaN` for the one key the
    // chord is built from.
    expect(screen.getByTestId('capsule-chain-keys')).toHaveTextContent(/^Shift$/);
    await userEvent.pointer({ target: shift, keys: '[/MouseLeft]' });
    await userEvent.click(screen.getByTestId('phys-key-Del'));
    await userEvent.click(
      within(screen.getByTestId('capsule-chain-bar')).getByRole('button', { name: 'Send' }),
    );
    expect(sendText).toHaveBeenNthCalledWith(2, 'semantic:Delete');
    expect(screen.getByTestId('terminal-keys-body')).toBe(body);

    await userEvent.click(screen.getByTestId('phys-key-↑'));
    expect(sendText).toHaveBeenNthCalledWith(3, 'semantic:ArrowUp');

    // Three taps, three sends — so the presence above cannot be passing because
    // the taps did nothing at all — over one accessory that never re-mounted.
    expect(sendText).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('terminal-keys-body')).toBe(body);
    expect(screen.getByTestId('phys-key-row')).toBe(row);
  });

  it('holds a key to open a chain, and another to send it', () => {
    // The chord, from the row rather than from the hook: hold a key to start a
    // chain, then hold a second key to send the chain with it.
    //
    // What this pins is the *encoding*, which is the whole point of criterion 4
    // and the one thing this gesture used to get wrong: it concatenated the
    // chain's bytes with the second key's into a single raw sequence, so a
    // cursor key in a chain carried whichever sequence the table had been
    // written with. Each key is now encoded on its own, at send time, through
    // the same semantic layer a tap uses — which is why these are two calls
    // naming two keys rather than one call holding `\x1b[A\x1b[3~`.
    vi.useFakeTimers();
    try {
      const { sendText } = renderKeys();

      fireEvent.pointerDown(screen.getByTestId('phys-key-↑'));
      act(() => {
        vi.advanceTimersByTime(CHAIN_LONG_PRESS_MS + 50);
      });
      fireEvent.pointerUp(screen.getByTestId('phys-key-↑'));

      // The strip names the arrow rather than the escape it will become — the
      // sequence is not knowable until it is sent, and is the terminal's to
      // decide.
      expect(screen.getByTestId('capsule-chain-keys')).toHaveTextContent(/^↑$/);

      fireEvent.pointerDown(screen.getByTestId('phys-key-Del'));
      act(() => {
        vi.advanceTimersByTime(CHAIN_LONG_PRESS_MS + 50);
      });
      fireEvent.pointerUp(screen.getByTestId('phys-key-Del'));

      expect(sendText.mock.calls).toEqual([['semantic:ArrowUp'], ['semantic:Delete']]);
      // Sent, so the chain it sent is closed rather than left holding keys that
      // have already gone to the terminal.
      expect(screen.queryByTestId('capsule-chain-bar')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

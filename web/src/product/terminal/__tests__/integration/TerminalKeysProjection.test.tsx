import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TerminalKeysProjection } from '@/product/terminal/TerminalKeysProjection';
import type {
  TerminalChordKey,
  TerminalChordModifier,
} from '@/platform/terminal-runtime/interaction/TerminalInteractionController';

type SendChord = (modifier: TerminalChordModifier, key: TerminalChordKey) => void;

function renderKeys({
  disabled = false,
  sendChord,
}: {
  disabled?: boolean;
  sendChord?: SendChord;
} = {}) {
  const sendPhysKey = vi.fn();
  const chord = sendChord ?? vi.fn<SendChord>();
  render(
    <TerminalKeysProjection
      sendPhysKey={sendPhysKey}
      sendChord={chord}
      disabled={disabled}
    />,
  );
  return { sendPhysKey, sendChord: chord };
}

describe('Terminal Keys panel', () => {
  it('shows common actions, arrows, modifiers and one-tap chords', () => {
    renderKeys();

    const functions = screen.getByTestId('phys-key-grid');
    const arrows = screen.getByTestId('arrow-key-grid');

    for (const label of ['Esc', 'Tab', 'Space', 'Enter', 'Del']) {
      expect(functions).toContainElement(screen.getByTestId(`phys-key-${label}`));
    }
    for (const label of ['↑', '←', '↓', '→']) {
      expect(arrows).toContainElement(screen.getByTestId(`phys-key-${label}`));
    }
    for (const modifier of ['ctrl', 'alt', 'shift']) {
      expect(screen.getByTestId(`terminal-modifier-${modifier}`)).toBeInTheDocument();
    }
    const quick = screen.getByTestId('terminal-quick-chords');
    expect(within(quick).getByTestId('quick-chord-Ctrl+C')).toBeInTheDocument();
    expect(within(quick).getByTestId('quick-chord-Ctrl+R')).toBeInTheDocument();
    expect(within(quick).getByTestId('quick-chord-Ctrl+L')).toBeInTheDocument();
  });

  it('sends a common key once per tap, through the semantic layer', async () => {
    const { sendPhysKey } = renderKeys();

    await userEvent.click(screen.getByTestId('phys-key-Esc'));
    await userEvent.click(screen.getByTestId('phys-key-Tab'));
    await userEvent.click(screen.getByTestId('phys-key-Esc'));

    expect(sendPhysKey.mock.calls).toEqual([
      [{ label: 'Esc', semanticKey: 'Escape' }],
      [{ label: 'Tab', semanticKey: 'Tab' }],
      [{ label: 'Esc', semanticKey: 'Escape' }],
    ]);
  });

  it('sends a first-class Ctrl+C as one atomic chord', async () => {
    const { sendChord, sendPhysKey } = renderKeys();

    await userEvent.click(screen.getByTestId('quick-chord-Ctrl+C'));

    expect(sendChord).toHaveBeenCalledTimes(1);
    expect(sendChord).toHaveBeenCalledWith('ctrl', 'C');
    expect(sendPhysKey).not.toHaveBeenCalled();
  });

  it('selects a one-shot modifier without sending anything', async () => {
    const { sendChord, sendPhysKey } = renderKeys();

    const ctrl = screen.getByTestId('terminal-modifier-ctrl');
    await userEvent.click(ctrl);

    expect(ctrl).toHaveAttribute('aria-pressed', 'true');
    expect(sendChord).not.toHaveBeenCalled();
    expect(sendPhysKey).not.toHaveBeenCalled();
    // The selector replaces the quick chords; it is a state, not a write.
    expect(screen.getByTestId('terminal-chord-letters')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-quick-chords')).toBeNull();
  });

  it('encodes the chosen letter with the selected modifier, then clears it', async () => {
    const { sendChord, sendPhysKey } = renderKeys();

    await userEvent.click(screen.getByTestId('terminal-modifier-ctrl'));
    await userEvent.click(screen.getByTestId('chord-letter-X'));

    expect(sendChord).toHaveBeenCalledTimes(1);
    expect(sendChord).toHaveBeenCalledWith('ctrl', 'X');
    expect(sendPhysKey).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-chord-letters')).toBeNull();
  });

  it('combines a selected modifier with a common key and clears it', async () => {
    const { sendChord, sendPhysKey } = renderKeys();

    await userEvent.click(screen.getByTestId('terminal-modifier-alt'));
    await userEvent.click(screen.getByTestId('phys-key-Tab'));

    expect(sendChord).toHaveBeenCalledWith('alt', 'Tab');
    expect(sendPhysKey).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-chord-letters')).toBeNull();
  });

  it('clears the selected modifier on Cancel', async () => {
    const { sendChord } = renderKeys();

    await userEvent.click(screen.getByTestId('terminal-modifier-shift'));
    await userEvent.click(screen.getByTestId('terminal-chord-cancel'));

    expect(sendChord).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-chord-letters')).toBeNull();
    expect(screen.getByTestId('terminal-quick-chords')).toBeInTheDocument();
  });

  it('toggles the same modifier off instead of stacking state', async () => {
    const { sendChord } = renderKeys();

    const ctrl = screen.getByTestId('terminal-modifier-ctrl');
    await userEvent.click(ctrl);
    await userEvent.click(ctrl);

    expect(ctrl).toHaveAttribute('aria-pressed', 'false');
    expect(sendChord).not.toHaveBeenCalled();
  });

  it('disables every key when the terminal is unavailable', () => {
    renderKeys({ disabled: true });

    for (const testId of [
      'phys-key-Esc',
      'phys-key-↑',
      'terminal-modifier-ctrl',
      'quick-chord-Ctrl+C',
    ]) {
      expect(screen.getByTestId(testId)).toBeDisabled();
    }
  });
});

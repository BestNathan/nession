import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CapsuleShell } from '../../CapsuleShell';
import { CapsuleExchangeContext } from '@/platform/motion/capsuleExchange';

function renderShell(progress: number | null) {
  const shell = (
    <CapsuleShell experience="app">
      <span>composer</span>
    </CapsuleShell>
  );
  return render(
    progress === null ? (
      shell
    ) : (
      <CapsuleExchangeContext.Provider value={{ progress }}>{shell}</CapsuleExchangeContext.Provider>
    ),
  );
}

describe('CapsuleShell capsule exchange', () => {
  it('steps aside and fades while a swipe carries the Workspace in', () => {
    // The outgoing half of the App handoff (owner follow-up, 2026-10-03): the
    // Conversation form drifts left and fades with the drag, so the two
    // capsule states read as one object changing state.
    renderShell(0.5);

    const dock = screen.getByTestId('terminal-capsule');
    expect(dock).toHaveAttribute('data-capsule-exchange', 'yielding');
    expect(dock.style.transform).toBe('translateX(-12px)');
    expect(dock.style.opacity).toBe('0.5');
    // A faded capsule must not take a tap meant as a drag.
    expect(dock.style.pointerEvents).toBe('none');
  });

  it('carries no exchange style at the endpoints or without an exchange', () => {
    // Web provides nothing; a settled App state sits at 0 or 1. Both must
    // leave the dock exactly as it was — no inline style, fully interactive.
    for (const progress of [null, 0, 1]) {
      const { unmount } = renderShell(progress);
      const dock = screen.getByTestId('terminal-capsule');
      expect(dock.getAttribute('style')).toBeNull();
      expect(dock).not.toHaveAttribute('data-capsule-exchange');
      unmount();
    }
  });
});

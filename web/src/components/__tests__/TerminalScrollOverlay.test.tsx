import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TerminalScrollOverlay } from '../TerminalScrollOverlay';

function setup() {
  const onScrollPages = vi.fn();
  const onScrollToBottom = vi.fn();
  render(
    <TerminalScrollOverlay
      onScrollPages={onScrollPages}
      onScrollToBottom={onScrollToBottom}
    />,
  );
  return { onScrollPages, onScrollToBottom };
}

describe('TerminalScrollOverlay', () => {
  it('renders page-up, page-down and scroll-to-bottom buttons', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Scroll up one page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll down one page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument();
  });

  it('page-up scrolls back one page', () => {
    const { onScrollPages } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll up one page' }));
    expect(onScrollPages).toHaveBeenCalledWith(-1);
  });

  it('page-down scrolls forward one page', () => {
    const { onScrollPages } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll down one page' }));
    expect(onScrollPages).toHaveBeenCalledWith(1);
  });

  it('bottom button jumps to the newest output', () => {
    const { onScrollToBottom } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(onScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('prevents pointerdown default so taps do not steal keyboard focus', () => {
    // fireEvent returns false when a cancelable event's preventDefault was
    // called — this is exactly the focus-steal guard we need on touch.
    setup();
    const up = fireEvent.pointerDown(screen.getByRole('button', { name: 'Scroll up one page' }));
    const down = fireEvent.pointerDown(screen.getByRole('button', { name: 'Scroll down one page' }));
    const bottom = fireEvent.pointerDown(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(up).toBe(false);
    expect(down).toBe(false);
    expect(bottom).toBe(false);
  });
});

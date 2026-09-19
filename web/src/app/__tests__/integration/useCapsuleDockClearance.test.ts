import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCapsuleDockClearance } from '@/product/terminal/capsule/hooks/useCapsuleDockClearance';

function rect(top: number, height: number) {
  return {
    bottom: top + height,
    top,
    left: 0,
    right: 300,
    width: 300,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

/**
 * The capsule's real DOM shape: the host contains a bottom-anchored dock, and
 * the dock contains — in order — any emerged projection and then the shell.
 *
 * Modelling the shape is the point. The clearance must come from the shell, and
 * a fixture that handed the hook a bare element could not tell the difference
 * between measuring the shell and measuring the dock.
 */
function capsuleDom({ withProjection }: { withProjection: boolean }) {
  const host = document.createElement('div');
  host.dataset.terminalCapsuleHost = '';
  host.style.setProperty('--terminal-capsule-terminal-clearance-gap', '0px');
  document.body.appendChild(host);

  const dock = document.createElement('div');
  host.appendChild(dock);

  let projection: HTMLElement | null = null;
  if (withProjection) {
    projection = document.createElement('div');
    dock.appendChild(projection);
  }
  const shell = document.createElement('div');
  dock.appendChild(shell);

  // Host bottom 400. The dock is bottom-anchored, so the shell sits at the same
  // place with or without a projection — the projection only grows the dock
  // upward. These numbers are the 390×844 measurement.
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect(0, 400));
  vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(rect(340, 60));
  vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue(
    withProjection ? rect(220, 180) : rect(340, 60),
  );
  if (projection) {
    vi.spyOn(projection, 'getBoundingClientRect').mockReturnValue(rect(220, 120));
  }

  return { host, shell };
}

describe('useCapsuleDockClearance', () => {
  let observe: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    observe = vi.fn();
    disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = disconnect;
        constructor(callback: ResizeObserverCallback) {
          observe.mockImplementation(() => {
            callback([], this as unknown as ResizeObserver);
          });
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes clearance on the capsule host from the shell geometry', () => {
    const { host, shell } = capsuleDom({ withProjection: false });

    const listener = vi.fn();
    host.addEventListener('terminal-capsule-occlusion', listener);
    renderHook(() => useCapsuleDockClearance({ current: shell }));

    expect(host.style.getPropertyValue('--terminal-capsule-occlusion')).toBe('60px');
    expect(observe).toHaveBeenCalledWith(shell);
    expect(observe).toHaveBeenCalledWith(host);
    expect(listener).toHaveBeenCalled();
  });

  it('does not grow for a projection floating above the shell (#826)', () => {
    // The occlusion is not advisory: `--terminal-content-bottom-inset` derives
    // from it and `TerminalViewport` spends it as padding-bottom inside a
    // `box-border` element xterm is mounted in. Measuring the dock made an
    // emerged Signal add its own height, so the terminal re-fit — rows changed
    // — every time a Signal appeared and went away, which is a temporary
    // surface reflowing the work surface.
    const without = capsuleDom({ withProjection: false });
    renderHook(() => useCapsuleDockClearance({ current: without.shell }));
    const dormant = without.host.style.getPropertyValue('--terminal-capsule-occlusion');

    const withProjection = capsuleDom({ withProjection: true });
    renderHook(() => useCapsuleDockClearance({ current: withProjection.shell }));
    const emerged = withProjection.host.style.getPropertyValue('--terminal-capsule-occlusion');

    expect(dormant).toBe('60px');
    // The dock's top moved 120px up; the clearance must not have noticed.
    expect(emerged).toBe(dormant);
  });
});

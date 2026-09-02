import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCapsuleDockClearance } from '@/session-first/capsule/hooks/useCapsuleDockClearance';

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

  it('publishes clearance on the capsule host from dock geometry', () => {
    const host = document.createElement('div');
    host.dataset.terminalCapsuleHost = '';
    host.style.setProperty('--composer-terminal-clearance-gap', '8px');
    document.body.appendChild(host);

    const dock = document.createElement('div');
    host.appendChild(dock);

    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      bottom: 400,
      top: 0,
      left: 0,
      right: 300,
      width: 300,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue({
      bottom: 380,
      top: 340,
      left: 0,
      right: 300,
      width: 300,
      height: 40,
      x: 0,
      y: 340,
      toJSON: () => ({}),
    });

    const dockRef = { current: dock };
    renderHook(() => useCapsuleDockClearance(dockRef));

    expect(host.style.getPropertyValue('--terminal-capsule-occlusion')).toBe('68px');
    expect(observe).toHaveBeenCalledWith(dock);
    expect(observe).toHaveBeenCalledWith(host);
  });
});

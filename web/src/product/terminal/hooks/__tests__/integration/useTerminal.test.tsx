import { createElement, StrictMode, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import { useTerminal } from '@/product/terminal/hooks/useTerminal';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';

const { controllerCtor, disposeMock } = vi.hoisted(() => ({
  controllerCtor: vi.fn(),
  disposeMock: vi.fn(),
}));

vi.mock('@/platform/terminal-runtime/controller/TerminalController', () => ({
  TerminalController: controllerCtor,
}));

/** The members useTerminal reads from the runtime — the controller is mocked. */
function makeRuntimeStub(): SessionRuntime {
  return {
    buildTransport: vi.fn(),
    subscribeTransportSwap: vi.fn(() => () => {}),
    setTransportReady: vi.fn(),
    updateViewportSize: vi.fn(),
  } as unknown as SessionRuntime;
}

describe('useTerminal lifecycle', () => {
  beforeEach(() => {
    controllerCtor.mockClear();
    disposeMock.mockClear();
  });

  it('passes the local-buffer scroll policy to the controller', () => {
    const controller = { dispose: disposeMock };
    controllerCtor.mockImplementation(function MockTerminalController() {
      return controller as unknown as TerminalController;
    });

    const { unmount } = renderHook(() => useTerminal({
      sessionId: 'agent:sess',
      sessionName: 'sess',
      mode: 'p2p',
      runtime: makeRuntimeStub(),
      rendererType: 'canvas',
      scrollbackMode: 'local-buffer',
    }));

    expect(controllerCtor).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ scrollbackMode: 'local-buffer' }),
    );
    unmount();
  });

  it('creates no controller until the runtime lease lands (#1309)', () => {
    const controller = { dispose: disposeMock };
    controllerCtor.mockImplementation(function MockTerminalController() {
      return controller as unknown as TerminalController;
    });

    // The runtime builds every transport the controller binds, so a controller
    // created before the lease lands could only bind a transport the runtime
    // did not issue. The hook waits instead — one commit with no viewport.
    const { result, rerender, unmount } = renderHook(
      ({ runtime }: { runtime: SessionRuntime | null }) => useTerminal({
        sessionId: 'agent:sess',
        sessionName: 'sess',
        mode: 'p2p',
        runtime,
        rendererType: 'canvas',
      }),
      { initialProps: { runtime: null as SessionRuntime | null } },
    );

    expect(result.current).toBeNull();
    expect(controllerCtor).not.toHaveBeenCalled();

    rerender({ runtime: makeRuntimeStub() });
    expect(result.current).not.toBeNull();
    expect(controllerCtor).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not dispose the active controller during StrictMode effect replay', async () => {
    const controller = { dispose: disposeMock };
    controllerCtor.mockImplementation(function MockTerminalController() {
      return controller as unknown as TerminalController;
    });

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children);

    const { unmount } = renderHook(
      () => useTerminal({
        sessionId: 'agent:sess',
        sessionName: 'sess',
        mode: 'p2p',
        runtime: makeRuntimeStub(),
        rendererType: 'canvas',
      }),
      { wrapper },
    );

    await Promise.resolve();
    expect(disposeMock).not.toHaveBeenCalled();
    unmount();
    await Promise.resolve();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });
});

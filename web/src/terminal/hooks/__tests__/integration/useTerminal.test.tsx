import { createElement, StrictMode, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalController } from '@/terminal/controller/TerminalController';
import { useTerminal } from '@/terminal/hooks/useTerminal';
import type { TerminalTransport } from '@/terminal/transport/TerminalTransport';

const { controllerCtor, disposeMock } = vi.hoisted(() => ({
  controllerCtor: vi.fn(),
  disposeMock: vi.fn(),
}));

vi.mock('@/terminal/controller/TerminalController', () => ({
  TerminalController: controllerCtor,
}));

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
      transportFactory: vi.fn() as unknown as () => TerminalTransport,
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
        transportFactory: vi.fn() as unknown as () => TerminalTransport,
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

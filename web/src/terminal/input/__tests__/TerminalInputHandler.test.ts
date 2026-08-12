// web/src/terminal/input/__tests__/TerminalInputHandler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TerminalInputHandler } from '../TerminalInputHandler';

function makeTransport() {
  return {
    mode: 'p2p' as const,
    send: vi.fn<(data: string) => void>(),
    sendResize: vi.fn<(cols: number, rows: number) => void>(),
    onOutput: null,
    onResize: null,
    onStateChange: null,
    onError: null,
    onDisconnect: null,
    dispose: vi.fn<() => void>(),
  };
}

function makeHandler() {
  let capturedCb: ((data: string) => void) | null = null;
  const unsub = vi.fn<() => void>();
  const xtermOnData = vi.fn<(cb: (data: string) => void) => () => void>((cb) => {
    capturedCb = cb;
    return unsub;
  });
  const transport = makeTransport();
  const handler = new TerminalInputHandler(transport, xtermOnData);
  return { transport, xtermOnData, unsub, getCb: () => capturedCb, handler };
}

describe('TerminalInputHandler', () => {
  it('has mode terminal', () => {
    const { handler } = makeHandler();
    expect(handler.mode).toBe('terminal');
  });

  it('activate subscribes to xterm onData', () => {
    const { handler, xtermOnData } = makeHandler();
    handler.activate();
    expect(xtermOnData).toHaveBeenCalledTimes(1);
  });

  it('deactivate unsubscribes from xterm onData', () => {
    const { handler, unsub } = makeHandler();
    handler.activate();
    handler.deactivate();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('forwards typed data to the transport', () => {
    const { handler, transport, getCb } = makeHandler();
    handler.activate();
    getCb()?.('ls -la');
    expect(transport.send).toHaveBeenCalledWith('ls -la');
  });

  it('intercepts Ctrl+D and routes it to onCtrlD', () => {
    const { handler, transport, getCb } = makeHandler();
    const onCtrlD = vi.fn();
    handler.onCtrlD = onCtrlD;
    handler.activate();
    getCb()?.('\x04');
    expect(onCtrlD).toHaveBeenCalledTimes(1);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('handle sends data directly without activation', () => {
    const { handler, transport } = makeHandler();
    handler.handle('x');
    expect(transport.send).toHaveBeenCalledWith('x');
  });
});

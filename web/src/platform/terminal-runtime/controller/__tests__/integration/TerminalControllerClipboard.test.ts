// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import type { TerminalSession } from '@/product/terminal/state/session';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import type { TerminalBootstrap } from '@/platform/terminal-runtime/bootstrap';
import type {
  ClipboardEffectPort,
  ClipboardNotice,
} from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';
import { encodeBase64Text } from '@/platform/terminal-runtime/clipboard/base64';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

interface MockTransport extends TerminalTransport {
  send: ReturnType<typeof vi.fn<(data: string) => void>>;
  sendResize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>;
  flushInputBuffer: ReturnType<typeof vi.fn<() => void>>;
  flushPendingResize: ReturnType<typeof vi.fn<() => void>>;
  flushAllOutbound: ReturnType<typeof vi.fn<() => void>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

function makeTransport(): MockTransport {
  return {
    mode: 'p2p',
    send: vi.fn<(data: string) => void>(),
    sendResize: vi.fn<(cols: number, rows: number) => void>(),
    flushInputBuffer: vi.fn<() => void>(),
    flushPendingResize: vi.fn<() => void>(),
    flushAllOutbound: vi.fn<() => void>(),
    onOutput: null,
    onResize: null,
    onError: null,
    dispose: vi.fn<() => void>(),
  };
}

function makeSession(): TerminalSession {
  return { id: 'agent1:sess', name: 'sess', status: 'connected', mode: 'p2p', startedAt: 1 };
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 80); });

const bytes = (text: string) => new TextEncoder().encode(text);
const osc52 = (text: string) => `\x1b]52;c;${encodeBase64Text(text)}\x1b\\`;

describe('TerminalController clipboard wiring (#2598)', () => {
  const hosts: HTMLDivElement[] = [];

  afterEach(() => {
    for (const host of hosts) { host.remove(); }
    hosts.length = 0;
  });

  function harness() {
    const transport = makeTransport();
    const effects = {
      writeText: vi.fn<(text: string) => Promise<void>>(async () => {}),
      writeClipboard: vi.fn<ClipboardEffectPort['writeClipboard']>(async () => {}),
      notice: vi.fn<(notice: ClipboardNotice) => void>(),
    };
    const notices: ClipboardNotice[] = [];
    const controller = new TerminalController(makeSession(), () => transport, {
      rendererType: 'canvas',
      clipboardEffects: effects,
      events: { onClipboardNotice: (notice) => notices.push(notice) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    controller.attach(host);
    return { controller, transport, effects, notices, host };
  }

  it('applies a live OSC 52 write and refuses replay and display writes', async () => {
    const { controller, transport, effects } = harness();
    transport.onOutput!(bytes(osc52('live')), undefined, { streamEpoch: 1, streamSeq: 1 });
    await flush();
    expect(effects.writeText).toHaveBeenCalledTimes(1);
    expect(effects.writeText).toHaveBeenCalledWith('live');

    const bootstrap: TerminalBootstrap = {
      requestedLines: 10,
      truncated: false,
      cutConsistency: 'atomic',
      fidelity: 'full-vt',
      streamEpoch: 1,
      throughSeq: 0,
    };
    transport.onOutput!(bytes(osc52('history')), bootstrap);
    await flush();
    expect(effects.writeText).toHaveBeenCalledTimes(1);

    controller.write(osc52('display'));
    await flush();
    expect(effects.writeText).toHaveBeenCalledTimes(1);
  });

  it('applies a relay frame that states no stream position', async () => {
    const { transport, effects } = harness();
    transport.onOutput!(bytes(osc52('relay')), undefined, undefined);
    await flush();
    expect(effects.writeText).toHaveBeenCalledWith('relay');
  });

  it('ignores a frame from a superseded stream epoch', async () => {
    const { transport, effects } = harness();
    transport.onOutput!(bytes(osc52('new epoch')), undefined, { streamEpoch: 7, streamSeq: 1 });
    await flush();
    transport.onOutput!(bytes(osc52('old epoch')), undefined, { streamEpoch: 6, streamSeq: 2 });
    await flush();
    expect(effects.writeText).toHaveBeenCalledTimes(1);
    expect(effects.writeText).toHaveBeenCalledWith('new epoch');
  });

  it('never performs effects or replies for an observer', async () => {
    const { controller, transport, effects } = harness();
    controller.setObserverReadOnly(true);
    transport.onOutput!(bytes(`${osc52('observer')}\x1b[?5522$p`), undefined, {
      streamEpoch: 1,
      streamSeq: 1,
    });
    await flush();
    expect(effects.writeText).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('announces an image-only paste once the TUI negotiated mode 5522', async () => {
    const { transport, effects, host } = harness();
    transport.onOutput!(bytes('\x1b[?5522h'), undefined, { streamEpoch: 1, streamSeq: 1 });
    await flush();

    const file = {
      type: 'image/png',
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    };
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? '' : ''),
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    });
    host.dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(effects.notice).not.toHaveBeenCalled();
    const frames = transport.send.mock.calls.map(([data]) => data);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('type=read:');
    expect(frames[0]).toContain(encodeBase64Text('Paste event'));
    // The offered MIME list is the announced payload.
    const payload = frames[0].slice(frames[0].lastIndexOf(';') + 1, -2);
    expect(new TextDecoder().decode(
      Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)),
    )).toBe('image/png');
  });

  it('states an unsupported image paste without sending anything when mode 5522 is off', async () => {
    const { transport, effects, host } = harness();
    const file = {
      type: 'image/png',
      arrayBuffer: async () => Uint8Array.from([1]).buffer,
    };
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: () => '',
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      },
    });
    host.dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(transport.send).not.toHaveBeenCalled();
    expect(effects.notice).toHaveBeenCalledWith({ kind: 'unsupported-image-paste' });
  });
});

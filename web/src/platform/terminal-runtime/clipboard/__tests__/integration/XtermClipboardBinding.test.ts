// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XtermEmulator } from '@/platform/terminal-runtime/xterm/XtermEmulator';
import { TerminalClipboardProtocol } from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';
import { encodeBase64Text } from '@/platform/terminal-runtime/clipboard/base64';
import type { TerminalWriteOrigin } from '@/platform/terminal-runtime/emulator';

// xterm touches matchMedia while opening; jsdom does not implement it.
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

const OSC = (body: string) => `\x1b]${body}\x1b\\`;

describe('xterm parser binding for OSC 52 / OSC 5522 (#2598)', () => {
  let emulator: XtermEmulator;
  let sent: string[];
  let texts: string[];
  let writes: Map<string, Uint8Array>[];
  let protocol: TerminalClipboardProtocol;

  beforeEach(() => {
    emulator = new XtermEmulator({ rendererType: 'canvas', fontSize: 14, scrollback: 100 });
    sent = [];
    texts = [];
    writes = [];
    protocol = new TerminalClipboardProtocol({
      sendToPty: (data) => sent.push(data),
      effects: {
        writeText: async (text) => { texts.push(text); },
        writeClipboard: async (variants) => { writes.push(new Map(variants)); },
        notice: () => {},
      },
      isAuthorized: () => true,
      createPassword: () => 'pw',
    });
    emulator.registerClipboardHost(protocol);
  });

  afterEach(() => {
    emulator.dispose();
    protocol.dispose();
  });

  async function write(data: string, origin: TerminalWriteOrigin = { source: 'live' }): Promise<void> {
    await new Promise<void>((resolve) => emulator.write(data, resolve, origin));
  }

  it('routes a live OSC 52 write to the clipboard and ignores replay', async () => {
    await write(OSC(`52;c;${encodeBase64Text('from the TUI')}`));
    expect(texts).toEqual(['from the TUI']);

    await write(OSC(`52;c;${encodeBase64Text('history')}`), { source: 'replay' });
    expect(texts).toEqual(['from the TUI']);
  });

  it('routes OSC 5522 write packets and replies DONE through the PTY channel', async () => {
    await write(OSC('5522;type=write:id=r1'));
    await write(OSC(`5522;type=wdata:mime=${encodeBase64Text('text/plain')};${encodeBase64Text('hi')}`));
    await write(OSC('5522;type=wdata'));
    // The final packet completes asynchronously; let the effect settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].get('text/plain')!)).toEqual([104, 105]);
    expect(sent).toContain('\x1b]5522;type=write:status=DONE:id=r1\x1b\\');
  });

  it('tracks DECSET/DECRST 5522 and answers DECRQM truthfully', async () => {
    await write(OSC('5522;type=read;' + encodeBase64Text('.')));
    await write('\x1b[?5522$p');
    expect(sent).toEqual(['\x1b]5522;type=read:status=OK\x1b\\', '\x1b]5522;type=read:status=DONE\x1b\\', '\x1b[?5522;2$y']);

    sent.length = 0;
    await write('\x1b[?5522h');
    await write('\x1b[?5522$p');
    expect(sent).toEqual(['\x1b[?5522;1$y']);

    sent.length = 0;
    await write('\x1b[?5522l');
    await write('\x1b[?5522$p');
    expect(sent).toEqual(['\x1b[?5522;2$y']);
  });

  it('leaves other DECRQM modes to xterm', async () => {
    const replies: string[] = [];
    const subscription = emulator.onData((data) => replies.push(data));
    await write('\x1b[?25$p');
    subscription.dispose();
    expect(replies).toContain('\x1b[?25;1$y');
  });

  it('announces a user paste with a one-time password and serves the read', async () => {
    await write('\x1b[?5522h');
    protocol.userPasted({ images: [{ mime: 'image/png', bytes: Uint8Array.from([7, 8, 9]) }] });
    expect(sent[0]).toContain('pw=');
    expect(sent[0]).toContain(encodeBase64Text('Paste event'));

    sent.length = 0;
    const read = `\x1b]5522;type=read:pw=${encodeBase64Text('pw')};${encodeBase64Text('image/png')}\x1b\\`;
    await write(read);
    const replies = sent.map((frame) => {
      const body = frame.slice('\x1b]5522;'.length, -2);
      const separator = body.indexOf(';');
      return separator < 0 ? body : body.slice(0, separator);
    });
    expect(replies[0]).toBe('type=read:status=OK');
    expect(replies[1]).toBe(`type=read:status=DATA:mime=${encodeBase64Text('image/png')}`);
    expect(replies[2]).toBe('type=read:status=DONE');
  });
});

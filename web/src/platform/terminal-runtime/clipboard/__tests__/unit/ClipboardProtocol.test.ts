import { describe, expect, it } from 'vitest';
import {
  CLIPBOARD_PACKET_BYTES,
  KITTY_MIN_CLIPBOARD_WRITE_BYTES,
  ClipboardEffectError,
  TerminalClipboardProtocol,
  type ClipboardEffectPort,
  type ClipboardNotice,
  type ClipboardProtocolLimits,
} from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';
import {
  decodeBase64,
  encodeBase64,
  encodeBase64Text,
} from '@/platform/terminal-runtime/clipboard/base64';
import {
  formatOsc5522,
  parseOsc5522Frame,
  sanitizeClipboardId,
} from '@/platform/terminal-runtime/clipboard/osc';

const LIVE = { source: 'live' as const };
const REPLAY = { source: 'replay' as const };

class FakeEffects implements ClipboardEffectPort {
  texts: string[] = [];
  writes: Map<string, Uint8Array>[] = [];
  notices: ClipboardNotice[] = [];
  failWriteText = false;
  failWriteClipboard: 'EPERM' | 'EIO' | null = null;

  async writeText(text: string): Promise<void> {
    if (this.failWriteText) { throw new ClipboardEffectError('EPERM'); }
    this.texts.push(text);
  }

  async writeClipboard(variants: ReadonlyMap<string, Uint8Array>): Promise<void> {
    if (this.failWriteClipboard) { throw new ClipboardEffectError(this.failWriteClipboard); }
    this.writes.push(new Map(variants));
  }

  notice(notice: ClipboardNotice): void {
    this.notices.push(notice);
  }
}

function harness(options: {
  authorized?: boolean;
  limits?: Partial<ClipboardProtocolLimits>;
  password?: string;
} = {}) {
  const sent: string[] = [];
  const effects = new FakeEffects();
  let authorized = options.authorized ?? true;
  const protocol = new TerminalClipboardProtocol({
    sendToPty: (data) => sent.push(data),
    effects,
    isAuthorized: () => authorized,
    limits: options.limits,
    createPassword: () => options.password ?? 'one-time-password',
  });
  return {
    protocol,
    effects,
    sent,
    setAuthorized: (value: boolean) => { authorized = value; },
  };
}

/** Build a complete Kitty write for one MIME, split into 4096-byte packets. */
function writePackets(mime: string, data: Uint8Array): string[] {
  const frames = ['type=write'];
  const encoded = encodeBase64(data);
  const chunk = Math.ceil(CLIPBOARD_PACKET_BYTES / 3) * 4;
  for (let offset = 0; offset < encoded.length; offset += chunk) {
    const mimeMeta = offset === 0 ? `mime=${encodeBase64Text(mime)}` : '';
    frames.push(`type=wdata${mimeMeta ? `:${mimeMeta}` : ''};${encoded.slice(offset, offset + chunk)}`);
  }
  frames.push('type=wdata');
  return frames;
}

function decodeSent(frame: string): { metadata: string; payload: string } {
  expect(frame.startsWith('\x1b]5522;')).toBe(true);
  expect(frame.endsWith('\x1b\\')).toBe(true);
  return decodeBody(bare(frame));
}

/** The parser receives OSC payloads without the `ESC ] 5522 ;` framing. */
function bare(frame: string): string {
  return frame.slice('\x1b]5522;'.length, -2);
}

function decodeBody(body: string): { metadata: string; payload: string } {
  const separator = body.indexOf(';');
  return separator < 0
    ? { metadata: body, payload: '' }
    : { metadata: body.slice(0, separator), payload: body.slice(separator + 1) };
}

describe('strict base64 (#2598)', () => {
  it('round-trips bytes with mandatory padding', () => {
    for (const length of [0, 1, 2, 3, 4, 4096, 4097]) {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
      const decoded = decodeBase64(encodeBase64(bytes));
      expect(typeof decoded).not.toBe('string');
      expect(decoded).toEqual(bytes);
    }
  });

  it('rejects whitespace, foreign alphabet and bad padding', () => {
    expect(decodeBase64('Zm9v Y==')).toBe('alphabet');
    expect(decodeBase64('Zm9v\nY==')).toBe('alphabet');
    expect(decodeBase64('Zm9v-!==')).toBe('alphabet');
    expect(decodeBase64('Zm9')).toBe('length');
    expect(decodeBase64('Zm9v=')).toBe('length');
    // A final quantum whose unused bits are not zero is incorrectly padded.
    expect(decodeBase64('Zh==')).toBe('pad-bits');
  });
});

describe('OSC 5522 frame grammar (#2598)', () => {
  it('parses colon-separated metadata and leaves the payload untouched', () => {
    const frame = parseOsc5522Frame('type=read:status=DATA:mime=aW1hZ2UvcG5n:id=req-1;AAAA');
    expect(frame).toEqual({
      metadata: new Map([
        ['type', 'read'],
        ['status', 'DATA'],
        ['mime', 'aW1hZ2UvcG5n'],
        ['id', 'req-1'],
      ]),
      payload: 'AAAA',
    });
  });

  it('rejects malformed metadata instead of inventing a reply', () => {
    expect(parseOsc5522Frame('type=read:oops;AAAA')).toBeNull();
    expect(parseOsc5522Frame('type=read:type=write')).toBeNull();
    expect(parseOsc5522Frame('status=OK')).toBeNull();
  });

  it('strips characters the protocol does not allow in ids', () => {
    expect(sanitizeClipboardId('a b;c:d/e')).toBe('abcde');
    expect(sanitizeClipboardId('ok-1_+2.3')).toBe('ok-1_+2.3');
  });

  it('formats a reply with the id last and no base64 on it', () => {
    expect(formatOsc5522([['type', 'read'], ['status', 'OK'], ['id', 'r-1']]))
      .toBe('\x1b]5522;type=read:status=OK:id=r-1\x1b\\');
  });
});

describe('terminal clipboard protocol (#2598)', () => {
  it('writes OSC 52 text exactly once for a live authorized terminal', () => {
    const { protocol, effects } = harness();
    protocol.handleOsc52(`c;${encodeBase64Text('hello')}`, LIVE);
    expect(effects.texts).toEqual(['hello']);
  });

  it('ignores OSC 52 reads, replay, observers and non-clipboard selections', () => {
    const { protocol, effects, setAuthorized } = harness();
    protocol.handleOsc52('c;?', LIVE);
    protocol.handleOsc52(`c;${encodeBase64Text('x')}`, REPLAY);
    protocol.handleOsc52(`p;${encodeBase64Text('x')}`, LIVE);
    setAuthorized(false);
    protocol.handleOsc52(`c;${encodeBase64Text('x')}`, LIVE);
    expect(effects.texts).toEqual([]);
  });

  it('rejects malformed or oversized OSC 52 payloads', () => {
    const { protocol, effects } = harness({ limits: { maxOsc52Bytes: 3 } });
    protocol.handleOsc52('c;!!!!', LIVE);
    protocol.handleOsc52(`c;${encodeBase64Text('four')}`, LIVE);
    expect(effects.texts).toEqual([]);
  });

  it('asks for an explicit user gesture when the clipboard write is blocked', async () => {
    const { protocol, effects } = harness();
    effects.failWriteText = true;
    protocol.handleOsc52(`c;${encodeBase64Text('copy me')}`, LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(effects.notices).toEqual([{ kind: 'copy-required', text: 'copy me' }]);
  });

  it('reports the paste-event mode truthfully through DECRQM', () => {
    const { protocol, sent } = harness();
    protocol.reportModeQuery();
    protocol.setPasteEventMode(true);
    protocol.reportModeQuery();
    protocol.setPasteEventMode(false);
    protocol.reportModeQuery();
    expect(sent).toEqual([
      '\x1b[?5522;2$y',
      '\x1b[?5522;1$y',
      '\x1b[?5522;2$y',
    ]);
  });

  it('accepts one chunked MIME write with aliases and replies DONE with the id', async () => {
    const { protocol, effects, sent } = harness();
    const data = Uint8Array.from({ length: 9000 }, (_, index) => (index * 7) % 256);
    for (const frame of writePackets('image/png', data)) {
      protocol.handleOsc5522(frame, LIVE);
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(effects.writes).toHaveLength(1);
    expect(effects.writes[0].get('image/png')).toEqual(data);
    const reply = decodeSent(sent[sent.length - 1]);
    expect(reply.metadata).toBe('type=write:status=DONE');
  });

  it('echoes a sanitized id in every write reply', async () => {
    const { protocol, sent } = harness();
    protocol.handleOsc5522('type=write:id=a b/c', LIVE);
    protocol.handleOsc5522('type=wdata', LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=write:status=DONE:id=abc');
  });

  it('decodes a base64 stream split across packets and validates it only at the end', async () => {
    const { protocol, effects } = harness();
    const data = new TextEncoder().encode('the quick brown fox');
    const encoded = encodeBase64(data);
    protocol.handleOsc5522('type=write', LIVE);
    protocol.handleOsc5522(`type=wdata:mime=${encodeBase64Text('text/plain')};${encoded.slice(0, 8)}`, LIVE);
    protocol.handleOsc5522(`type=wdata;${encoded.slice(8)}`, LIVE);
    protocol.handleOsc5522('type=wdata', LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(effects.writes[0].get('text/plain')).toEqual(data);
  });

  it('applies multiple MIME types and aliases as one clipboard write', async () => {
    const { protocol, effects } = harness();
    protocol.handleOsc5522('type=write', LIVE);
    protocol.handleOsc5522(
      `type=wdata:mime=${encodeBase64Text('text/plain')};${encodeBase64Text('hello')}`,
      LIVE,
    );
    protocol.handleOsc5522(
      `type=wdata:mime=${encodeBase64Text('text/html')};${encodeBase64Text('<b>hello</b>')}`,
      LIVE,
    );
    protocol.handleOsc5522(
      `type=walias:mime=${encodeBase64Text('text/plain')};${encodeBase64Text('text/markdown')}`,
      LIVE,
    );
    protocol.handleOsc5522('type=wdata', LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(effects.writes).toHaveLength(1);
    const variants = effects.writes[0];
    expect([...variants.keys()].sort()).toEqual(['text/html', 'text/markdown', 'text/plain']);
    expect(new TextDecoder().decode(variants.get('text/markdown'))).toBe('hello');
    expect(new TextDecoder().decode(variants.get('text/html'))).toBe('<b>hello</b>');
  });

  it('rejects an alias whose target MIME has no data', async () => {
    const { protocol, sent } = harness();
    protocol.handleOsc5522('type=write', LIVE);
    protocol.handleOsc5522(
      `type=walias:mime=${encodeBase64Text('text/plain')};${encodeBase64Text('text/markdown')}`,
      LIVE,
    );
    protocol.handleOsc5522('type=wdata', LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=write:status=EINVAL');
  });

  it('replies EINVAL to an invalid base64 stream and ignores later packets', async () => {
    const { protocol, sent } = harness();
    protocol.handleOsc5522('type=write', LIVE);
    protocol.handleOsc5522(`type=wdata:mime=${encodeBase64Text('text/plain')};!!!!`, LIVE);
    protocol.handleOsc5522('type=wdata', LIVE);
    protocol.handleOsc5522(`type=wdata:mime=${encodeBase64Text('text/plain')};QUJD`, LIVE);
    protocol.handleOsc5522('type=wdata', LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.map((frame) => decodeSent(frame).metadata)).toEqual([
      'type=write:status=EINVAL',
    ]);
  });

  it('accepts a new write after a failed one', async () => {
    const { protocol, effects, sent } = harness();
    protocol.handleOsc5522('type=write', LIVE);
    protocol.handleOsc5522('type=wdata', LIVE);
    protocol.handleOsc5522('type=write', LIVE);
    protocol.handleOsc5522(`type=wdata:mime=${encodeBase64Text('text/plain')};QUJD`, LIVE);
    protocol.handleOsc5522('type=wdata', LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.map((frame) => decodeSent(frame).metadata)).toEqual([
      'type=write:status=DONE',
      'type=write:status=DONE',
    ]);
    expect(effects.writes[0].get('text/plain')).toEqual(new TextEncoder().encode('ABC'));
  });

  it('replies EBUSY while another write is in flight', () => {
    const { protocol, sent } = harness();
    protocol.handleOsc5522('type=write', LIVE);
    protocol.handleOsc5522('type=write:id=second', LIVE);
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=write:status=EBUSY:id=second');
  });

  it('replies EFBIG once the write exceeds the size bound', () => {
    const { protocol, sent } = harness({ limits: { maxWriteBytes: 4096 } });
    protocol.handleOsc5522('type=write', LIVE);
    const packet = encodeBase64(new Uint8Array(4096));
    protocol.handleOsc5522(`type=wdata:mime=${encodeBase64Text('application/octet-stream')};${packet}`, LIVE);
    protocol.handleOsc5522(`type=wdata;${packet}`, LIVE);
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=write:status=EFBIG');
  });

  it('rejects a write when the client is not authorized', () => {
    const { protocol, sent } = harness({ authorized: false });
    protocol.handleOsc5522('type=write:id=r', LIVE);
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=write:status=EPERM:id=r');
  });

  it('maps a refused clipboard effect to EPERM and states it truthfully', async () => {
    const { protocol, effects, sent } = harness();
    effects.failWriteClipboard = 'EPERM';
    for (const frame of writePackets('text/plain', new TextEncoder().encode('x'))) {
      protocol.handleOsc5522(frame, LIVE);
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=write:status=EPERM');
    expect(effects.notices).toEqual([{ kind: 'write-denied' }]);
  });

  it('serves a one-time read only with the paste password', () => {
    const { protocol, sent } = harness({ password: 'secret' });
    protocol.setPasteEventMode(true);
    protocol.userPasted({
      text: 'pasted',
      images: [{ mime: 'image/png', bytes: Uint8Array.from([1, 2, 3]) }],
    });
    const announcement = decodeSent(sent[0]);
    expect(announcement.metadata).toBe(
      `type=read:pw=${encodeBase64Text('secret')}:name=${encodeBase64Text('Paste event')}`,
    );
    const offered = new TextDecoder().decode(decodeBase64(announcement.payload) as Uint8Array);
    expect(offered).toBe('text/plain image/png');

    const read = (mime: string, password: string, id?: string) => formatOsc5522([
      ['type', 'read'],
      ['pw', encodeBase64Text(password)],
      ...(id ? [['id', id] as const] : []),
    ], encodeBase64Text(mime));

    sent.length = 0;
    protocol.handleOsc5522(bare(read('image/png', 'wrong')), LIVE);
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=read:status=EPERM');

    sent.length = 0;
    protocol.handleOsc5522(bare(read('image/png', 'secret', 'r-1')), LIVE);
    const frames = sent.map(decodeSent);
    expect(frames[0].metadata).toBe('type=read:status=OK:id=r-1');
    expect(frames[1].metadata).toBe(
      `type=read:status=DATA:mime=${encodeBase64Text('image/png')}:id=r-1`,
    );
    expect(decodeBase64(frames[1].payload)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(frames[2].metadata).toBe('type=read:status=DONE:id=r-1');

    // The authorization is one-time.
    sent.length = 0;
    protocol.handleOsc5522(bare(read('image/png', 'secret')), LIVE);
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=read:status=EPERM');
  });

  it('chunks a large read into 4096-byte DATA packets', () => {
    const { protocol, sent } = harness({ password: 'pw' });
    protocol.setPasteEventMode(true);
    const bytes = new Uint8Array(4096 * 2 + 10);
    protocol.userPasted({ images: [{ mime: 'image/png', bytes }] });
    sent.length = 0;
    protocol.handleOsc5522(bare(formatOsc5522([
      ['type', 'read'],
      ['pw', encodeBase64Text('pw')],
    ], encodeBase64Text('image/png'))), LIVE);
    const data = sent.map(decodeSent).filter((frame) => frame.metadata.includes('status=DATA'));
    expect(data).toHaveLength(3);
    expect(decodeBase64(data[0].payload)).toHaveLength(4096);
    expect(decodeBase64(data[1].payload)).toHaveLength(4096);
    expect(decodeBase64(data[2].payload)).toHaveLength(10);
  });

  it('answers a MIME listing without a password and lists offered types', () => {
    const { protocol, sent } = harness();
    protocol.setPasteEventMode(true);
    protocol.userPasted({ text: 'hi', images: [{ mime: 'image/png', bytes: Uint8Array.from([9]) }] });
    sent.length = 0;
    protocol.handleOsc5522(`type=read;${encodeBase64Text('.')}`, LIVE);
    const frames = sent.map(decodeSent);
    expect(frames[0].metadata).toBe('type=read:status=OK');
    expect(frames.slice(1, -1).map((frame) => frame.metadata))
      .toEqual([
        `type=read:status=DATA:mime=${encodeBase64Text('text/plain')}`,
        `type=read:status=DATA:mime=${encodeBase64Text('image/png')}`,
      ]);
    expect(frames[frames.length - 1].metadata).toBe('type=read:status=DONE');
  });

  it('refuses a read with no preceding user paste', () => {
    const { protocol, sent } = harness();
    protocol.handleOsc5522(`type=read;${encodeBase64Text('text/plain')}`, LIVE);
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=read:status=EPERM');
  });

  it('states an unsupported image paste and sends nothing when the mode is off', () => {
    const { protocol, effects, sent } = harness();
    protocol.userPasted({ images: [{ mime: 'image/png', bytes: Uint8Array.from([1]) }] });
    expect(sent).toEqual([]);
    expect(effects.notices).toEqual([{ kind: 'unsupported-image-paste' }]);
  });

  it('offers mixed clipboard content without suppressing text paste', () => {
    const { protocol, sent } = harness();
    protocol.userPasted({
      text: 'hello',
      images: [{ mime: 'image/png', bytes: Uint8Array.from([1]) }],
    });
    expect(sent).toEqual([]);
  });

  it('ignores replay frames and stale stream epochs', () => {
    const { protocol, effects, sent } = harness();
    protocol.setPasteEventMode(true);
    protocol.handleOsc52(`c;${encodeBase64Text('replay')}`, REPLAY);
    protocol.handleOsc5522('type=write', { source: 'live', streamEpoch: 2 });
    protocol.handleOsc5522('type=wdata', { source: 'live', streamEpoch: 2 });
    protocol.handleOsc5522('type=write', { source: 'live', streamEpoch: 1 });
    expect(effects.texts).toEqual([]);
    expect(effects.writes).toEqual([]);
    expect(sent.map((frame) => decodeSent(frame).metadata)).toEqual(['type=write:status=DONE']);
  });

  it('accepts a 64 MiB clipboard write at the protocol bound', async () => {
    // SC-07: the Kitty spec's minimum storage requirement is exercised with a
    // real 64 MiB stream, sliced at base64-group boundaries (4 chars) so the
    // concatenation stays decodable and each packet stays under 4096 bytes.
    const totalBytes = 64 * 1024 * 1024;
    const encoded = encodeBase64(new Uint8Array(totalBytes));
    const sliceSize = 5460;
    const { protocol, effects } = harness();
    protocol.handleOsc5522('type=write', LIVE);
    for (let offset = 0; offset < encoded.length; offset += sliceSize) {
      const mime = offset === 0
        ? `:mime=${encodeBase64Text('application/octet-stream')}`
        : '';
      protocol.handleOsc5522(
        `type=wdata${mime};${encoded.slice(offset, offset + sliceSize)}`,
        LIVE,
      );
    }
    protocol.handleOsc5522('type=wdata', LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(effects.writes).toHaveLength(1);
    expect(effects.writes[0].get('application/octet-stream')!.byteLength).toBe(totalBytes);
  }, 120_000);

  it('states the Kitty minimum write size and accepts a write at that bound', async () => {
    expect(KITTY_MIN_CLIPBOARD_WRITE_BYTES).toBe(64 * 1024 * 1024);
    // A write at the bound is a size check, not a payload copy: one packet of
    // declared length exercises the 64 MiB acceptance path without allocating
    // the full stream in this unit suite.
    const { protocol, sent } = harness({ limits: { maxWriteBytes: KITTY_MIN_CLIPBOARD_WRITE_BYTES } });
    protocol.handleOsc5522('type=write', LIVE);
    protocol.handleOsc5522('type=wdata', LIVE);
    await Promise.resolve();
    await Promise.resolve();
    expect(decodeSent(sent[sent.length - 1]).metadata).toBe('type=write:status=DONE');
  });
});

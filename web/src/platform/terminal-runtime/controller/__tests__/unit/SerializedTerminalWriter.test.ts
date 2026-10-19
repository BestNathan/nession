import { describe, expect, it, vi } from 'vitest';
import {
  SerializedTerminalWriter,
  type TerminalWriteTarget,
} from '@/platform/terminal-runtime/controller/SerializedTerminalWriter';

function harness() {
  const called: string[] = [];
  const callbacks: Array<() => void> = [];
  const terminal: TerminalWriteTarget = {
    write: vi.fn((data: string | Uint8Array, callback: () => void) => {
      called.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
      callbacks.push(callback);
    }),
    resize: vi.fn((cols: number, rows: number) => { called.push(`resize:${cols}x${rows}`); }),
  };
  return { writer: new SerializedTerminalWriter(terminal), called, callbacks, terminal };
}

describe('SerializedTerminalWriter (#1931)', () => {
  it('serializes bootstrap reset, snapshot, output and authoritative resize', () => {
    const h = harness();
    const parsed: string[] = [];

    h.writer.write('reset');
    h.writer.write('snapshot', () => parsed.push('snapshot'));
    h.writer.resize(120, 30);
    h.writer.write(new TextEncoder().encode('live'), () => parsed.push('live'));

    expect(h.called).toEqual(['reset']);
    expect(parsed).toEqual([]);
    h.callbacks.shift()!();
    expect(h.called).toEqual(['reset', 'snapshot']);

    h.callbacks.shift()!();
    expect(parsed).toEqual(['snapshot']);
    expect(h.called).toEqual(['reset', 'snapshot', 'resize:120x30', 'live']);

    h.callbacks.shift()!();
    expect(parsed).toEqual(['snapshot', 'live']);
  });

  it('never allows resize to overtake an incomplete write', () => {
    const h = harness();
    h.writer.write('first');
    h.writer.resize(90, 20);
    h.writer.resize(100, 30);
    h.writer.write('second');

    expect(h.called).toEqual(['first']);
    h.callbacks.shift()!();
    expect(h.called).toEqual(['first', 'resize:90x20', 'resize:100x30', 'second']);
  });

  it('supports synchronous parser callbacks without reentrant double delivery', () => {
    const called: string[] = [];
    const terminal: TerminalWriteTarget = {
      write: (data, callback) => {
        called.push(String(data));
        callback();
      },
      resize: (cols, rows) => { called.push(`resize:${cols}x${rows}`); },
    };
    const writer = new SerializedTerminalWriter(terminal);
    const parsed: string[] = [];
    writer.write('one', () => {
      parsed.push('one');
      writer.resize(80, 24);
      writer.write('two', () => parsed.push('two'));
    });
    expect(called).toEqual(['one', 'resize:80x24', 'two']);
    expect(parsed).toEqual(['one', 'two']);
  });

  it('discards queued operations and ignores the pending callback on disposal', () => {
    const h = harness();
    const parsed = vi.fn();
    h.writer.write('running', parsed);
    h.writer.write('queued', parsed);
    h.writer.resize(40, 10);
    h.writer.dispose();
    h.callbacks.shift()!();
    h.writer.write('after dispose', parsed);
    h.writer.resize(50, 15);

    expect(h.called).toEqual(['running']);
    expect(parsed).not.toHaveBeenCalled();
  });

  it('reports sequenced resize only after prior xterm write parsing, not on enqueue', () => {
    const h = harness();
    const applied: string[] = [];
    h.writer.write('before', () => applied.push('write:1'));
    h.writer.resize(120, 30, () => applied.push('resize:2'));
    h.writer.write('after', () => applied.push('write:3'));
    expect(h.called).toEqual(['before']);
    expect(applied).toEqual([]);
    h.callbacks.shift()!();
    expect(h.called).toEqual(['before', 'resize:120x30', 'after']);
    expect(applied).toEqual(['write:1', 'resize:2']);
    h.callbacks.shift()!();
    expect(applied).toEqual(['write:1', 'resize:2', 'write:3']);
  });

  it('cannot acknowledge a resize dropped when its writer is disposed', () => {
    const h = harness();
    const applied = vi.fn();
    h.writer.write('blocking');
    h.writer.resize(70, 20, applied);
    h.writer.dispose();
    h.callbacks.shift()!();
    expect(applied).not.toHaveBeenCalled();
    expect(h.called).toEqual(['blocking']);
  });

  it('does not treat call-to-write as parser completion', () => {
    const h = harness();
    let applied = 0;
    h.writer.write('a', () => { applied = 1; });
    h.writer.write('b', () => { applied = 2; });
    expect(applied).toBe(0);
    h.callbacks.shift()!();
    expect(applied).toBe(1);
    h.callbacks.shift()!();
    expect(applied).toBe(2);
  });
});


describe('SerializedTerminalWriter bounded parser queue (#1975)', () => {
  it('halts on event-count pressure and never acknowledges dropped or pending output', () => {
    const h = harness();
    const degraded = vi.fn();
    const writer = new SerializedTerminalWriter(h.terminal, degraded, {
      maxEvents: 2, maxBytes: 4096, maxParseMs: 30_000,
    });
    const parsed = vi.fn();
    writer.write('first', parsed); // xterm is parsing this one
    writer.write('queued', parsed);
    expect(writer.pendingUsage.events).toBe(2);
    writer.write('overflow', parsed);
    expect(degraded).toHaveBeenCalledOnce();
    expect(degraded).toHaveBeenCalledWith('overflow');
    expect(writer.pendingUsage).toEqual({ bytes: 138, events: 1, halted: true });
    h.callbacks.shift()!(); // late callback of the in-flight write
    expect(writer.pendingUsage).toEqual({ bytes: 0, events: 0, halted: true });
    writer.resize(100, 30, parsed);
    writer.write('after', parsed);
    expect(parsed).not.toHaveBeenCalled();
    expect(h.called).toEqual(['first']);
    writer.dispose();
  });

  it('charges actual output retention and rejects an oversized event', () => {
    const h = harness();
    const degraded = vi.fn();
    const writer = new SerializedTerminalWriter(h.terminal, degraded, {
      maxEvents: 4, maxBytes: 140, maxParseMs: 30_000,
    });
    writer.write('small');
    expect(writer.pendingUsage.bytes).toBe(138);
    writer.write(new Uint8Array(8192));
    expect(degraded).toHaveBeenCalledWith('overflow');
    expect(writer.pendingUsage.halted).toBe(true);
    expect(h.called).toEqual(['small']);
    writer.dispose();
  });

  it('treats a stalled parser as loss of proof and ignores its late callback', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const degraded = vi.fn();
      const parsed = vi.fn();
      const writer = new SerializedTerminalWriter(h.terminal, degraded, {
        maxEvents: 8, maxBytes: 4096, maxParseMs: 15,
      });
      writer.write('never-parsed', parsed);
      writer.write('queued', parsed);
      vi.advanceTimersByTime(15);
      expect(degraded).toHaveBeenCalledOnce();
      expect(degraded).toHaveBeenCalledWith('parser-stalled');
      h.callbacks.shift()!();
      expect(parsed).not.toHaveBeenCalled();
      expect(h.called).toEqual(['never-parsed']);
      writer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases byte/event charges on callback and preserves healthy FIFO', () => {
    const h = harness();
    const degraded = vi.fn();
    const writer = new SerializedTerminalWriter(h.terminal, degraded, {
      maxEvents: 3, maxBytes: 600, maxParseMs: 30_000,
    });
    const parsed: string[] = [];
    writer.write('first', () => parsed.push('first'));
    writer.resize(110, 32, () => parsed.push('resize'));
    writer.write('last', () => parsed.push('last'));
    expect(writer.pendingUsage.events).toBe(3);
    h.callbacks.shift()!();
    expect(parsed).toEqual(['first', 'resize']);
    h.callbacks.shift()!();
    expect(parsed).toEqual(['first', 'resize', 'last']);
    expect(writer.pendingUsage).toEqual({ bytes: 0, events: 0, halted: false });
    expect(degraded).not.toHaveBeenCalled();
    writer.dispose();
  });

  it('validates byte/event/stall limits rather than disabling them', () => {
    const h = harness();
    for (const invalid of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new SerializedTerminalWriter(h.terminal, undefined, { maxBytes: invalid }))
        .toThrow(RangeError);
      expect(() => new SerializedTerminalWriter(h.terminal, undefined, { maxEvents: invalid }))
        .toThrow(RangeError);
      expect(() => new SerializedTerminalWriter(h.terminal, undefined, { maxParseMs: invalid }))
        .toThrow(RangeError);
    }
  });
});

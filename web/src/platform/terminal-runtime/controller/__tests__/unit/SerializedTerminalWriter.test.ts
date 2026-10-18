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

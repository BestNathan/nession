import { describe, expect, it, vi } from 'vitest';
import { applyTerminalStreamEvents, parseStreamEvents } from '@/platform/terminal-runtime/streamApply';

describe('streamApply', () => {
  it('parses output and resize events from resume payload', () => {
    const events = parseStreamEvents([
      {
        kind: 'output',
        session_name: 's',
        stream_epoch: 1,
        stream_seq: 2,
        data: 'aGk=',
      },
      {
        kind: 'resize',
        session_name: 's',
        stream_epoch: 1,
        stream_seq: 3,
        cols: 100,
        rows: 30,
      },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('output');
    expect(events[1]?.kind).toBe('resize');
  });

  it('applies events to handlers in order', () => {
    const onOutput = vi.fn();
    const onResize = vi.fn();
    applyTerminalStreamEvents(
      [
        {
          kind: 'output',
          streamEpoch: 1,
          streamSeq: 1,
          data: 'aGk=',
        },
        {
          kind: 'resize',
          streamEpoch: 1,
          streamSeq: 2,
          cols: 80,
          rows: 24,
        },
      ],
      { onOutput, onResize },
    );
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(new Uint8Array([104, 105]), {
      streamEpoch: 1,
      streamSeq: 1,
    });
    expect(onResize).toHaveBeenCalledWith(80, 24, {
      streamEpoch: 1,
      streamSeq: 2,
    });
  });

  it('carries the recorded lease generation through replay (#2286 SC-03)', () => {
    const [event] = parseStreamEvents([
      {
        kind: 'resize',
        session_name: 's',
        stream_epoch: 1,
        stream_seq: 3,
        cols: 100,
        rows: 30,
        control_generation: 8,
      },
    ]);
    expect(event).toEqual({
      kind: 'resize',
      streamEpoch: 1,
      streamSeq: 3,
      cols: 100,
      rows: 30,
      controlGeneration: 8,
    });

    const onResize = vi.fn();
    applyTerminalStreamEvents(
      [event!],
      { onOutput: vi.fn(), onResize },
    );
    expect(onResize).toHaveBeenCalledWith(
      100,
      30,
      { streamEpoch: 1, streamSeq: 3 },
      8,
    );
  });

  it('reads an absent or malformed generation as unstated, not as zero', () => {
    const [absent] = parseStreamEvents([
      {
        kind: 'resize',
        session_name: 's',
        stream_epoch: 1,
        stream_seq: 3,
        cols: 100,
        rows: 30,
      },
    ]);
    const [malformed] = parseStreamEvents([
      {
        kind: 'resize',
        session_name: 's',
        stream_epoch: 1,
        stream_seq: 4,
        cols: 100,
        rows: 30,
        control_generation: 'eight',
      },
    ]);
    expect(absent && 'controlGeneration' in absent).toBe(false);
    expect(malformed && 'controlGeneration' in malformed).toBe(false);
  });
});

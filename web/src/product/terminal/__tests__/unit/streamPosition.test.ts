import { describe, expect, it } from 'vitest';
import { readAgentStreamPosition } from '../../streamPosition';

describe('Agent-issued stream position contract (#2067)', () => {
  it('admits only the complete safe positive Agent epoch and sequence pair', () => {
    expect(readAgentStreamPosition({ stream_epoch: 1, stream_seq: 1 })).toEqual({
      streamEpoch: 1,
      streamSeq: 1,
    });
    expect(readAgentStreamPosition({
      stream_epoch: Number.MAX_SAFE_INTEGER,
      stream_seq: Number.MAX_SAFE_INTEGER,
    })).toEqual({
      streamEpoch: Number.MAX_SAFE_INTEGER,
      streamSeq: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([
    ['missing both', undefined, undefined],
    ['missing epoch', undefined, 1],
    ['missing sequence', 1, undefined],
    ['zero epoch', 0, 1],
    ['zero sequence', 1, 0],
    ['negative epoch', -1, 1],
    ['negative sequence', 1, -1],
    ['fractional epoch', 1.25, 1],
    ['fractional sequence', 1, 1.25],
    ['NaN epoch', NaN, 1],
    ['NaN sequence', 1, NaN],
    ['infinite epoch', Infinity, 1],
    ['infinite sequence', 1, Infinity],
    ['negative infinity', -Infinity, 1],
    ['unsafe epoch', Number.MAX_SAFE_INTEGER + 1, 1],
    ['unsafe sequence', 1, Number.MAX_SAFE_INTEGER + 1],
    ['text epoch', '1', 1],
    ['text sequence', 1, '1'],
    ['null epoch', null, 1],
    ['null sequence', 1, null],
  ])('does not manufacture an event position from %s', (_label, epoch, seq) => {
    expect(readAgentStreamPosition({ stream_epoch: epoch, stream_seq: seq })).toBeUndefined();
  });

  it('never coerces out-of-contract payloads into a trusted cursor', () => {
    expect(readAgentStreamPosition({ stream_epoch: true, stream_seq: 1 })).toBeUndefined();
    expect(readAgentStreamPosition({ stream_epoch: 1, stream_seq: false })).toBeUndefined();
    expect(readAgentStreamPosition({ stream_epoch: 1n, stream_seq: 2n })).toBeUndefined();
    expect(readAgentStreamPosition({ stream_epoch: [], stream_seq: {} })).toBeUndefined();
  });
});

import type { TerminalStreamPosition } from '@/platform/terminal-runtime/streamApply';

/**
 * The only valid Agent-authored position (#2067).
 *
 * Both P2P and Relay consume the same output/resize wires. JavaScript accepts
 * NaN, infinities, fractional numbers and unsafe integers as `number`, but
 * none proves a real Agent stream ordinal. A half-stated pair is legacy level
 * data, not a valid point in the ordered stream. Never invent either field.
 */
export function readAgentStreamPosition(
  payload: { stream_epoch?: unknown; stream_seq?: unknown },
): TerminalStreamPosition | undefined {
  const epoch = payload.stream_epoch;
  const seq = payload.stream_seq;
  if (typeof epoch !== 'number' || typeof seq !== 'number'
    || !Number.isSafeInteger(epoch) || epoch <= 0
    || !Number.isSafeInteger(seq) || seq <= 0) {
    return undefined;
  }
  return { streamEpoch: epoch, streamSeq: seq };
}

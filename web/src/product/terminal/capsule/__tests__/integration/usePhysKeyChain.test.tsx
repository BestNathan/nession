import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePhysKeyChain } from '../../usePhysKeyChain';
import type { PhysKey } from '../../physKeys';

/**
 * The chain's encoding rule, tested where it is decided.
 *
 * The integration test beside `TerminalKeysProjection` drives this through
 * pointer events, which is the right level for "does the row work". This one is
 * about a single rule that the row can only observe indirectly: **every key in
 * a chain is encoded the way a tapped one is**, so a cursor key in a chain
 * follows the terminal's current mode instead of a sequence that was baked into
 * the table (#1096 criterion 4).
 */

const shift: PhysKey = { label: 'Shift', seq: '' };
const del: PhysKey = { label: 'Del', semanticKey: 'Delete' };
const up: PhysKey = { label: '↑', semanticKey: 'ArrowUp' };
const ctrlC: PhysKey = { label: 'Ctrl+C', seq: '\x03' };

function setup() {
  const sendSeq = vi.fn();
  // The seam: a semantic key never reaches `sendSeq` as itself, which is what
  // makes the assertions below about *routing* rather than about bytes.
  const sendPhysKey = vi.fn((key: PhysKey) => {
    sendSeq(`semantic:${key.semanticKey}`);
  });
  const { result } = renderHook(() => usePhysKeyChain(sendSeq, sendPhysKey));
  return { result, sendSeq, sendPhysKey };
}

type Hook = { current: ReturnType<typeof usePhysKeyChain> };

/**
 * Hold the first key to open a chain, tap the rest into it, then send it.
 *
 * One `act` per interaction, because each one has to be able to see the state
 * the one before it produced — `sendChain` closes over the buffer as of its own
 * render, so batching the taps with it would send the wrong chain.
 */
function chainThenSend(result: Hook, keys: PhysKey[]) {
  chain(result, keys);
  act(() => {
    result.current.sendChain();
  });
}

function chain(result: Hook, keys: PhysKey[]) {
  const [first, ...rest] = keys;
  if (!first) {
    return;
  }
  act(() => {
    result.current.handleChainStart(first);
  });
  for (const key of rest) {
    act(() => {
      result.current.handleChainAdd(key);
    });
  }
}

describe('usePhysKeyChain', () => {
  it('sends every chained key through the semantic seam, not as raw bytes', () => {
    const { result, sendSeq } = setup();

    chainThenSend(result, [del, up]);

    expect(sendSeq).toHaveBeenCalledWith('semantic:Delete');
    expect(sendSeq).toHaveBeenCalledWith('semantic:ArrowUp');
  });

  it('sends a chained key the same way a tapped one is sent', () => {
    // The property that was false: the tap path always went semantic, the chain
    // path concatenated `seq`. Asserting the two produce the *same* call is
    // what stops them drifting apart again.
    const tap = setup();
    act(() => {
      tap.result.current.handlePhysKey(up);
    });

    const chain = setup();
    chainThenSend(chain.result, [up]);

    expect(chain.sendSeq.mock.calls).toEqual(tap.sendSeq.mock.calls);
  });

  it('sends the key that completed the chain after the ones already in it', () => {
    // The "hold a key while the chain is open" gesture. This is the call site
    // that used to join the chain's bytes with the key's, which is how a
    // chained cursor key carried the sequence for whichever mode was current
    // when the table was written.
    const { result, sendSeq, sendPhysKey } = setup();

    chain(result, [up]);
    act(() => {
      result.current.completeChain(ctrlC);
    });

    expect(sendSeq.mock.calls).toEqual([['semantic:ArrowUp'], ['\x03']]);
    expect(sendPhysKey).toHaveBeenCalledTimes(1);
  });

  it('closes the chain it completed, so the same keys cannot be sent twice', () => {
    const { result } = setup();

    chain(result, [up]);
    act(() => {
      result.current.completeChain(ctrlC);
    });

    expect(result.current.isChaining).toBe(false);
    expect(result.current.chainBuffer).toEqual([]);
  });

  it('clears the chain it sent', () => {
    const { result } = setup();

    chainThenSend(result, [del, up]);

    expect(result.current.isChaining).toBe(false);
    expect(result.current.chainBuffer).toEqual([]);
  });

  it('does not put a no-op write on the wire for a key that carries no bytes', () => {
    // `Shift` exists to start a chord; the key it modifies carries the bytes.
    const { result, sendSeq } = setup();

    chainThenSend(result, [shift]);

    expect(sendSeq).not.toHaveBeenCalled();
  });

  it('still sends a raw control byte, which has no semantic form', () => {
    const { result, sendSeq, sendPhysKey } = setup();

    chainThenSend(result, [ctrlC]);

    expect(sendSeq).toHaveBeenCalledWith('\x03');
    expect(sendPhysKey).not.toHaveBeenCalled();
  });
});

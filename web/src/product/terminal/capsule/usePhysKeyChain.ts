import { useCallback, useState } from 'react';
import type { PhysKey } from '@/product/terminal/capsule/physKeys';

/**
 * Sending physical keys to the terminal, including the long-press chord.
 *
 * A tap sends one key; holding one starts a chain, and further taps append to
 * it until it is sent or cancelled — which is how Ctrl-C is reachable from a
 * touch keyboard.
 *
 * Extracted so the two places that offer the keys share one implementation.
 * The key row lives in the Commands panel and, since #826, is also a Terminal
 * capability in its own right; a second copy of this would have been a second
 * chord implementation free to drift from the first, and the drift would look
 * like "the keys behave differently depending on where you opened them".
 */
export interface PhysKeyChain {
  /** The keys accumulating into the chain, in the order they were added. */
  chainBuffer: readonly PhysKey[];
  isChaining: boolean;
  /** One key, sent immediately. Also ends any chain. */
  handlePhysKey: (key: PhysKey) => void;
  handleChainStart: (key: PhysKey) => void;
  handleChainAdd: (key: PhysKey) => void;
  cancelChain: () => void;
  /** Send every key in the chain, then clear it. */
  sendChain: () => void;
  /**
   * Send every key in the chain **plus** `key`, then clear it: what holding a
   * key while the chain is open means. Composed here rather than by the caller
   * so "send and close" has one implementation — it used to be the row joining
   * the chain's bytes itself, which is how a chained cursor key ended up frozen
   * at the wrong mode's sequence.
   */
  completeChain: (key: PhysKey) => void;
}

/**
 * Send one key the way a tap would: through the semantic layer when it has one.
 *
 * A module function because both the tap path and the chain path must do
 * *exactly* this, and the whole defect this fixes was the chain doing something
 * else — joining raw bytes it had been handed, which froze a cursor key at the
 * sequence for the mode that happened to be current when the table was written.
 */
function sendKey(
  key: PhysKey,
  sendSeq: (seq: string) => void,
  sendPhysKey: (key: PhysKey) => void,
): void {
  if (key.semanticKey) {
    sendPhysKey(key);
    return;
  }
  // A key with no bytes sends nothing. `Shift` is the one that matters: it
  // exists to *start* a chord and the key it modifies carries the bytes, so
  // emitting an empty write for it would put a no-op frame on the wire for
  // every modifier the user holds.
  if (key.seq) {
    sendSeq(key.seq);
  }
}

export function usePhysKeyChain(
  sendSeq: (seq: string) => void,
  sendPhysKey: (key: PhysKey) => void,
): PhysKeyChain {
  const [chainBuffer, setChainBuffer] = useState<PhysKey[]>([]);
  const [isChaining, setIsChaining] = useState(false);

  const handlePhysKey = useCallback(
    (key: PhysKey) => {
      sendKey(key, sendSeq, sendPhysKey);
      setIsChaining(false);
      setChainBuffer([]);
    },
    [sendPhysKey, sendSeq],
  );

  const handleChainStart = useCallback((key: PhysKey) => {
    setIsChaining(true);
    setChainBuffer([key]);
  }, []);

  const handleChainAdd = useCallback((key: PhysKey) => {
    setChainBuffer((prev) => [...prev, key]);
  }, []);

  const cancelChain = useCallback(() => {
    setIsChaining(false);
    setChainBuffer([]);
  }, []);

  const sendKeys = useCallback(
    (keys: readonly PhysKey[]) => {
      // Each key is encoded on its own, at send time — so a chained cursor key
      // follows the terminal's mode as it is *now*, which is what the tap path
      // has always done and what this path used to skip.
      for (const key of keys) {
        sendKey(key, sendSeq, sendPhysKey);
      }
    },
    [sendPhysKey, sendSeq],
  );

  const sendChain = useCallback(() => {
    sendKeys(chainBuffer);
    setIsChaining(false);
    setChainBuffer([]);
  }, [chainBuffer, sendKeys]);

  const completeChain = useCallback(
    (key: PhysKey) => {
      sendKeys([...chainBuffer, key]);
      setIsChaining(false);
      setChainBuffer([]);
    },
    [chainBuffer, sendKeys],
  );

  return {
    chainBuffer,
    isChaining,
    handlePhysKey,
    handleChainStart,
    handleChainAdd,
    cancelChain,
    sendChain,
    completeChain,
  };
}

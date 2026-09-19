import { useCallback, useState } from 'react';

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
  chainBuffer: readonly string[];
  isChaining: boolean;
  /** One key, sent immediately. Also ends any chain. */
  handlePhysKey: (seq: string) => void;
  handleChainStart: (seq: string) => void;
  handleChainAdd: (seq: string) => void;
  cancelChain: () => void;
  sendChain: () => void;
}

export function usePhysKeyChain(sendText: (text: string) => void): PhysKeyChain {
  const [chainBuffer, setChainBuffer] = useState<string[]>([]);
  const [isChaining, setIsChaining] = useState(false);

  const handlePhysKey = useCallback(
    (seq: string) => {
      sendText(seq);
      setIsChaining(false);
      setChainBuffer([]);
    },
    [sendText],
  );

  const handleChainStart = useCallback((seq: string) => {
    setIsChaining(true);
    setChainBuffer([seq]);
  }, []);

  const handleChainAdd = useCallback((seq: string) => {
    setChainBuffer((prev) => [...prev, seq]);
  }, []);

  const cancelChain = useCallback(() => {
    setIsChaining(false);
    setChainBuffer([]);
  }, []);

  const sendChain = useCallback(() => {
    sendText(chainBuffer.join(''));
    setIsChaining(false);
    setChainBuffer([]);
  }, [sendText, chainBuffer]);

  return {
    chainBuffer,
    isChaining,
    handlePhysKey,
    handleChainStart,
    handleChainAdd,
    cancelChain,
    sendChain,
  };
}

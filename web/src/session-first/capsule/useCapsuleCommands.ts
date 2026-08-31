import { useState, useCallback, useMemo } from 'react';
import { PRESETS, type QuickCommand } from '@/components/quickCommands';
import { useQuickCommands } from '@/hooks/useQuickCommands';
import { useCommandHistory } from '@/hooks/useCommandHistory';

export function useCapsuleCommands(sendText: (text: string) => void) {
  const { userCommands, addCommand, deleteCommand } = useQuickCommands();
  const { addEntry } = useCommandHistory();
  const [chainBuffer, setChainBuffer] = useState<string[]>([]);
  const [isChaining, setIsChaining] = useState(false);

  const allCommands = useMemo(
    () => [...PRESETS, ...userCommands],
    [userCommands],
  );

  const presetIds = useMemo(
    () => new Set(PRESETS.map((preset) => preset.id)),
    [],
  );

  const handleRun = useCallback(
    (cmd: QuickCommand) => {
      const text = cmd.raw ? cmd.command : `${cmd.command}\r`;
      sendText(text);
      addEntry(cmd.command);
    },
    [sendText, addEntry],
  );

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
    allCommands,
    presetIds,
    chainBuffer,
    isChaining,
    handleRun,
    handlePhysKey,
    handleChainStart,
    handleChainAdd,
    cancelChain,
    sendChain,
    addCommand,
    deleteCommand,
  };
}

import { useCallback, useMemo } from 'react';
import { PRESETS, useQuickCommands, type QuickCommand } from '@/capabilities/commands';
import { useCommandHistory } from '@/product/terminal/hooks/useCommandHistory';
import { usePhysKeyChain } from '@/product/terminal/capsule/usePhysKeyChain';

export function useCapsuleCommands(sendText: (text: string) => void) {
  const { userCommands, addCommand, deleteCommand } = useQuickCommands();
  const { addEntry } = useCommandHistory();
  // The key row's chord lives beside it rather than here, because since #826
  // the key row is also a Terminal capability and both entries must behave
  // identically (`usePhysKeyChain`).
  const keys = usePhysKeyChain(sendText);

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

  return {
    allCommands,
    presetIds,
    ...keys,
    handleRun,
    addCommand,
    deleteCommand,
  };
}

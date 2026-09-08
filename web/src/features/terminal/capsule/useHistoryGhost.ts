import { useMemo, useCallback } from 'react';
import type { HistoryEntry } from '@/hooks/useCommandHistory';

export function useHistoryGhost(inputValue: string, entries: HistoryEntry[]) {
  const ghostSuffix = useMemo(() => {
    if (!inputValue) {
      return '';
    }
    const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
    const match = sorted.find(
      (entry) =>
        entry.command.startsWith(inputValue) &&
        entry.command.length > inputValue.length,
    );
    return match ? match.command.slice(inputValue.length) : '';
  }, [inputValue, entries]);

  const acceptGhost = useCallback(() => inputValue + ghostSuffix, [inputValue, ghostSuffix]);

  return {
    ghostSuffix,
    acceptGhost,
    hasGhost: ghostSuffix.length > 0,
  };
}

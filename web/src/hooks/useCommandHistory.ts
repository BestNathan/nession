import { useState, useCallback } from 'react';

const STORAGE_KEY = 'nession_command_history';
const MAX_ENTRIES = 500;

export interface HistoryEntry {
  id: string;
  command: string;
  timestamp: number;
}

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `hist_${Date.now()}_${idCounter}`;
}

function loadFromStorage(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (e: unknown): e is HistoryEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as HistoryEntry).id === 'string' &&
        typeof (e as HistoryEntry).command === 'string' &&
        typeof (e as HistoryEntry).timestamp === 'number',
    );
  } catch {
    return [];
  }
}

function saveToStorage(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or unavailable — silently ignore.
  }
}

export interface UseCommandHistoryReturn {
  history: HistoryEntry[];
  addEntry: (command: string) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
  filterHistory: (query: string) => HistoryEntry[];
}

export function useCommandHistory(): UseCommandHistoryReturn {
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadFromStorage());

  const addEntry = useCallback((command: string) => {
    setHistory((prev) => {
      const existingIdx = prev.findIndex((e) => e.command === command);
      let next: HistoryEntry[];
      if (existingIdx !== -1) {
        const existing = prev[existingIdx];
        next = [
          { ...existing, timestamp: Date.now() },
          ...prev.slice(0, existingIdx),
          ...prev.slice(existingIdx + 1),
        ];
      } else {
        next = [
          { id: generateId(), command, timestamp: Date.now() },
          ...prev,
        ];
      }
      if (next.length > MAX_ENTRIES) {
        next = next.slice(0, MAX_ENTRIES);
      }
      saveToStorage(next);
      return next;
    });
  }, []);

  const removeEntry = useCallback((id: string) => {
    setHistory((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveToStorage(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveToStorage([]);
  }, []);

  const filterHistory = useCallback(
    (query: string): HistoryEntry[] => {
      if (!query) {
        return [...history].sort((a, b) => b.timestamp - a.timestamp);
      }
      const lower = query.toLowerCase();
      return history
        .filter((e) => e.command.toLowerCase().includes(lower))
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    [history],
  );

  return { history, addEntry, removeEntry, clearHistory, filterHistory };
}

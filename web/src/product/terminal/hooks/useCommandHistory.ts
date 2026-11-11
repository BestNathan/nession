import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'nession_command_history';
const MAX_ENTRIES = 500;
const EMPTY_HISTORY: HistoryEntry[] = [];

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

/**
 * One reactive owner for the persisted command history (#3189).
 *
 * The History popover, ghost completion and the Capsule send action must see
 * the same live history. A per-hook `useState` snapshot cannot do that: the
 * browser `storage` event does not fire in the writing document, so every
 * separately mounted hook stayed stale until remount. This module-level store
 * is the owner the three consumers subscribe to; it is deliberately local to
 * the terminal product (not a global Workspace store) and keeps the existing
 * bounded persistence, dedupe and recency semantics.
 */
let current: HistoryEntry[] | null = null;
const listeners = new Set<() => void>();
let listeningForStorage = false;

function readSnapshot(): HistoryEntry[] {
  current ??= loadFromStorage();
  return current;
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function commit(next: HistoryEntry[]): void {
  current = next;
  saveToStorage(next);
  emit();
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== STORAGE_KEY) {
    return;
  }
  current = loadFromStorage();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!listeningForStorage && typeof window !== 'undefined') {
    window.addEventListener('storage', handleStorage);
    listeningForStorage = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && listeningForStorage && typeof window !== 'undefined') {
      window.removeEventListener('storage', handleStorage);
      listeningForStorage = false;
    }
  };
}

function getServerSnapshot(): HistoryEntry[] {
  return EMPTY_HISTORY;
}

function addEntry(command: string): void {
  const trimmed = command.trim();
  if (!trimmed) {
    return;
  }
  const prev = readSnapshot();
  const existingIdx = prev.findIndex((entry) => entry.command === trimmed);
  let next: HistoryEntry[];
  if (existingIdx !== -1) {
    const existing = prev[existingIdx];
    next = [
      { ...existing, timestamp: Date.now() },
      ...prev.slice(0, existingIdx),
      ...prev.slice(existingIdx + 1),
    ];
  } else {
    next = [{ id: generateId(), command: trimmed, timestamp: Date.now() }, ...prev];
  }
  if (next.length > MAX_ENTRIES) {
    next = next.slice(0, MAX_ENTRIES);
  }
  commit(next);
}

function removeEntry(id: string): void {
  commit(readSnapshot().filter((entry) => entry.id !== id));
}

function clearHistory(): void {
  commit([]);
}

export interface UseCommandHistoryReturn {
  history: HistoryEntry[];
  addEntry: (command: string) => void;
  removeEntry: (id: string) => void;
  clearHistory: () => void;
  filterHistory: (query: string) => HistoryEntry[];
}

export function useCommandHistory(): UseCommandHistoryReturn {
  const history = useSyncExternalStore(subscribe, readSnapshot, getServerSnapshot);

  const filterHistory = useCallback(
    (query: string): HistoryEntry[] => {
      if (!query) {
        return [...history].sort((a, b) => b.timestamp - a.timestamp);
      }
      const lower = query.toLowerCase();
      return history
        .filter((entry) => entry.command.toLowerCase().includes(lower))
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    [history],
  );

  return { history, addEntry, removeEntry, clearHistory, filterHistory };
}

/**
 * Test-only reset for the module-level store.
 *
 * Vitest stubs `localStorage` per test; without this the next test would reuse
 * the previous test's in-memory snapshot instead of its own storage stub.
 */
export function resetCommandHistoryForTests(): void {
  current = null;
  listeners.clear();
  if (listeningForStorage && typeof window !== 'undefined') {
    window.removeEventListener('storage', handleStorage);
    listeningForStorage = false;
  }
}

import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Debounced input hook for search fields.
 * Returns current value, setter, debounced value, and a sync setter.
 *
 * - `setValue(v)` schedules `debouncedValue` to update to `v` after `delay`ms.
 * - `syncValue(v)` updates both `value` and `debouncedValue` immediately,
 *   cancelling any pending debounce (for syncing external prop changes).
 */
export function useDebouncedInput<T>(initialValue: T, delay = 300) {
  const [value, setValueState] = useState(initialValue);
  const [debouncedValue, setDebouncedValue] = useState(initialValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setValue = useCallback((next: T) => {
    setValueState(next);

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      setDebouncedValue(next);
      timerRef.current = null;
    }, delay);
  }, [delay]);

  /**
   * Sync setter: updates both value and debouncedValue immediately,
   * cancelling any pending debounce. Use this when an external prop
   * changes and the debounced downstream effect should not re-fire.
   */
  const syncValue = useCallback((next: T) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setValueState(next);
    setDebouncedValue(next);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { value, setValue, debouncedValue, syncValue };
}

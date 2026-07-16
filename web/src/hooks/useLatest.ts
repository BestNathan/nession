import { useRef, useEffect } from 'react';

/**
 * Keep a ref synchronized with the latest value.
 * Eliminates the need for useEffect blocks that just sync refs.
 */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

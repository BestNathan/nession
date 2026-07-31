import { useEffect, useRef } from 'react';

/**
 * Reset dialog state when it opens (false → true transition only).
 *
 * The callback is read from a ref so it never needs to appear in the
 * dependency array — this prevents data-array changes (e.g. a new
 * `agents` reference from a realtime push) from cascading through
 * `useCallback` into this effect and resetting form state while the
 * dialog is open.
 */
export function useDialogReset(isOpen: boolean, callback: () => void): void {
  const wasOpen = useRef(false);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      callbackRef.current();
    }
    wasOpen.current = isOpen;
  }, [isOpen]);
}

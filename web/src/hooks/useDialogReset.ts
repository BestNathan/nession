import { useEffect } from 'react';

/**
 * Reset dialog state when it opens.
 * Common pattern: clear loading/error state when dialog becomes visible.
 */
export function useDialogReset(isOpen: boolean, callback: () => void): void {
  useEffect(() => {
    if (isOpen) {
      callback();
    }
  }, [isOpen, callback]);
}

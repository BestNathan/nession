import { useCallback } from 'react';
import { useAtom } from 'jotai';
import { clipboardNoticeAtomFamily } from '../state/ui';

/**
 * The Session's transient OSC 52/5522 clipboard state (#2598).
 *
 * The dismissal is stable so the status strip's expiry timer is armed once per
 * notice id rather than on every surface render.
 */
export function useClipboardNotice(sessionId: string) {
  const [clipboardNotice, setClipboardNotice] = useAtom(
    clipboardNoticeAtomFamily(sessionId),
  );
  const dismissClipboardNotice = useCallback(
    () => setClipboardNotice(null),
    [setClipboardNotice],
  );
  return { clipboardNotice, dismissClipboardNotice };
}

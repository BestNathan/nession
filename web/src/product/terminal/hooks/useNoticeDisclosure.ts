import { useEffect, useRef, useState } from 'react';
import type { InputDrop } from '@/platform/terminal-runtime/inputQueue';
import type { ClipboardNoticeState } from '@/product/terminal/state/ui';
import type { TerminalControlState } from '@/product/terminal/state/terminalControl';

interface NoticeDisclosureInput {
  historyDegraded: boolean;
  inputDrop: InputDrop | null;
  clipboardNotice: ClipboardNoticeState | null;
  terminalControl?: TerminalControlState;
  onDismissClipboardNotice?: () => void;
}

/**
 * The Terminal's notice availability and its opt-in disclosure (#2658).
 *
 * The Terminal has no automatic status chrome. This hook answers three
 * questions for the surface: whether any notice exists (the Capsule action is
 * the only automatic trace), whether the user has opened the disclosure, and
 * how long the transient clipboard state lasts. It also publishes the
 * diagnostic token (`data-terminal-notices`) without exposing notice content.
 */
export function useNoticeDisclosure({
  historyDegraded,
  inputDrop,
  clipboardNotice,
  terminalControl,
  onDismissClipboardNotice,
}: NoticeDisclosureInput) {
  const hasNotices = Boolean(
    historyDegraded || inputDrop || clipboardNotice || terminalControl?.role === 'observer',
  );
  const [open, setOpen] = useState(false);

  /**
   * `open` is the user's intent, not the dialog's visibility: when the last
   * notice disappears (dismissed, expired, or the observer took control), the
   * intent resets, so a later notice can only be opened by a new gesture.
   * Without this reset, a stale `true` would reopen the dialog automatically
   * the next time a notice arrived.
   */
  useEffect(() => {
    if (!hasNotices) {
      setOpen(false);
    }
  }, [hasNotices]);

  const dialogOpen = hasNotices && open;

  /**
   * The clipboard state stays transient whether or not its disclosure is open.
   *
   * `copy-required` gets the old 10 s while it is only an unopened action, and
   * a fresh 30 s once the user opens the disclosure to act on it; the other
   * three are bounded statements with no action. `dialogOpen` is a dependency
   * so opening restarts the window.
   *
   * The dependencies are the notice's identity (`id`/`kind`) rather than the
   * object: a parent that recreates the state object or the dismissal callback
   * on an unrelated render must not re-arm the timer, or a transient notice
   * could outlive its boundary indefinitely. This is the rule the pre-#2658
   * strip used, kept because moving the sentence into the dialog did not move
   * the expiry owner.
   */
  const clipboardNoticeId = clipboardNotice?.id ?? null;
  const clipboardNoticeKind = clipboardNotice?.notice.kind ?? null;
  const canDismiss = Boolean(onDismissClipboardNotice);
  // The latest callback without making its identity a timer dependency.
  const dismissRef = useRef(onDismissClipboardNotice);
  useEffect(() => {
    dismissRef.current = onDismissClipboardNotice;
  }, [onDismissClipboardNotice]);
  useEffect(() => {
    if (clipboardNoticeId === null || !canDismiss) {
      return;
    }
    const lifetime = clipboardNoticeKind === 'copy-required'
      ? (dialogOpen ? 30_000 : 10_000)
      : 5_000;
    const timer = setTimeout(() => dismissRef.current?.(), lifetime);
    return () => clearTimeout(timer);
  }, [clipboardNoticeId, clipboardNoticeKind, dialogOpen, canDismiss]);

  // A diagnostic seam, never content: the token names which notices exist so
  // browser tests can observe state without opening (or mounting) the dialog.
  // Clipboard text is deliberately absent and only reaches the DOM inside the
  // user-opened disclosure.
  const notices = [
    historyDegraded ? 'history-degraded' : '',
    inputDrop ? 'input-drop' : '',
    clipboardNotice ? 'clipboard' : '',
    terminalControl?.role === 'observer' ? 'observer' : '',
  ].filter(Boolean).join(' ');

  return { hasNotices, dialogOpen, setOpen, notices };
}

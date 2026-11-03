/**
 * The one browser text-copy owner for user-initiated copy (#2656).
 *
 * `copy-to-clipboard` (MIT, pinned in `web/package.json`) is the single
 * open-source implementation behind every user-gesture text copy in Nession:
 * ordinary UI copy actions and the Terminal's blocked-OSC notice all call this
 * module. The library chooses the Async Clipboard API on secure origins and a
 * hidden-selection `document.execCommand('copy')` on ordinary HTTP.
 *
 * ## Call it from the activating event
 *
 * Invoke these functions synchronously inside the click/key handler. The
 * library's HTTP branch runs its DOM copy during the call, before the returned
 * Promise settles; on a secure origin the async branch settles later. A caller
 * that awaits something else first may have spent the transient user
 * activation, and must not retry the legacy path from the rejection
 * continuation as though the gesture still existed.
 *
 * ## Truthful results
 *
 * `copyText` resolves `true` only when the browser reports the copy and
 * `false` when it refuses or the command is unsupported. The library's
 * `window.prompt` fallback is disabled: Nession keeps its own bounded
 * selectable-text surface instead.
 */
import copy from 'copy-to-clipboard';

/** Copy text from a user gesture; `false` means the browser did not copy. */
export function copyText(text: string): Promise<boolean> {
  return copy(text, { fallbackToPrompt: false });
}

/**
 * Whether this origin can perform a programmatic (non-gesture) clipboard
 * write (#2614, #2656).
 *
 * The Async Clipboard API is absent on ordinary HTTP, and a caller must not
 * spend a user gesture or an automatic remote write on a call that cannot
 * exist. A browser that exposes the API only to refuse still reports `true`
 * here; the refusal surfaces at call time as the truthful error.
 */
export function asyncClipboardWriteAvailable(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return false;
  }
  return typeof navigator.clipboard?.writeText === 'function';
}

/**
 * Copy text for the ordinary UI, rejecting when the browser refuses.
 *
 * Existing copy actions surface failure through a rejected promise (an error
 * toast); this wrapper preserves that contract over the library's boolean.
 * Call it from the click, not after an unrelated await.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (!(await copyText(text))) {
    throw new Error('the browser did not complete the clipboard copy');
  }
}

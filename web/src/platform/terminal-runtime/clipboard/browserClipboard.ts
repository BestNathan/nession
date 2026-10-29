/**
 * Browser Clipboard API adapter for the terminal clipboard protocols (#2598).
 *
 * This is the only module that touches `navigator.clipboard`. It reports
 * permission refusal as `EPERM` (the protocol's truthful reply) and any other
 * failure as `EIO`, so the protocol never claims a write that did not happen.
 *
 * ## Ordinary HTTP is not a secure context (#2614)
 *
 * Browsers expose the async Clipboard API only on secure origins, so a page
 * served over plain HTTP (the deployed staging origin is one) has no
 * `navigator.clipboard`. A remote `OSC 52`/`OSC 5522` write therefore cannot
 * complete automatically there and must not pretend to: the protocol answers
 * `EPERM`, and the surface offers a **user-gesture** copy instead. That path is
 * the deprecated `document.execCommand('copy')` with a scoped `copy` listener —
 * it runs inside the click, carries the bytes only for the duration of the
 * event, and never touches `navigator.clipboard`.
 */
import {
  ClipboardEffectError,
  type ClipboardEffectPort,
  type ClipboardNotice,
} from './ClipboardProtocol';

export interface BrowserClipboardOptions {
  /** Surface a transient truthful state (blocked copy, refused write, …). */
  notice?: (notice: ClipboardNotice) => void;
}

function isPermissionError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

function clipboardApi(): Clipboard | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.clipboard;
}

/**
 * Whether this origin can perform a programmatic (async) clipboard write.
 *
 * The API is absent on ordinary HTTP (#2614) and the answer is checked before
 * a user gesture is spent on a call that cannot run there. A browser that
 * exposes the API only to refuse it falls through to `EPERM` at call time.
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
 * Copy text from inside a user gesture, for origins without the async API.
 *
 * Must be called synchronously from the activating event (a click): the
 * transient activation is what lets the browser execute the command. The
 * payload lives only in the listener's `ClipboardEvent`, and the listener is
 * removed before returning — no lasting selection, focus or history.
 *
 * Returns whether the browser executed the copy with this text. `false` is
 * the truthful answer on browsers that no longer support the command; the
 * caller must then present a selectable surface rather than claim success.
 */
export function copyTextFromUserGesture(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  let delivered = false;
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
    delivered = true;
  };
  document.addEventListener('copy', onCopy, true);
  try {
    return document.execCommand('copy') && delivered;
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
}

/** A BlobPart backed by a plain ArrayBuffer (never a shared one). */
function blobPart(bytes: Uint8Array): BlobPart {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export class BrowserClipboardEffects implements ClipboardEffectPort {
  constructor(private readonly options: BrowserClipboardOptions = {}) {}

  /** Whether `writeText` can act on this origin (#2614). */
  writeTextIsProgrammatic(): boolean {
    return asyncClipboardWriteAvailable();
  }

  /** The user-gesture fallback for origins without the async API (#2614). */
  writeTextFromGesture(text: string): boolean {
    return copyTextFromUserGesture(text);
  }

  /**
   * Write text. The Clipboard API prompts or refuses depending on permission,
   * secure context and user activation; both outcomes reach the caller here.
   */
  async writeText(text: string): Promise<void> {
    const clipboard = clipboardApi();
    if (!clipboard?.writeText) {
      throw new ClipboardEffectError('EPERM');
    }
    try {
      await clipboard.writeText(text);
    } catch (error) {
      throw new ClipboardEffectError(isPermissionError(error) ? 'EPERM' : 'EIO');
    }
  }

  /**
   * Write one clipboard item carrying every requested MIME (and alias) as its
   * own representation. Browsers expose only the types they support; an
   * unsupported item surfaces as EIO rather than a false success.
   */
  async writeClipboard(variants: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const clipboard = clipboardApi();
    const ClipboardItemCtor = (globalThis as Record<string, unknown>)['ClipboardItem'] as
      | typeof ClipboardItem
      | undefined;
    if (!clipboard?.write || !ClipboardItemCtor || variants.size === 0) {
      throw new ClipboardEffectError('EPERM');
    }
    const record: Record<string, Blob> = {};
    for (const [type, bytes] of variants) {
      record[type] = new Blob([blobPart(bytes)], { type });
    }
    try {
      await clipboard.write([new ClipboardItemCtor(record)]);
    } catch (error) {
      throw new ClipboardEffectError(isPermissionError(error) ? 'EPERM' : 'EIO');
    }
  }

  notice(notice: ClipboardNotice): void {
    this.options.notice?.(notice);
  }
}

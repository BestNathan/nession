/**
 * The one browser clipboard owner for Nession (#2656).
 *
 * `copy-to-clipboard` (MIT, pinned in `web/package.json`) is the single
 * open-source implementation behind user-gesture text copy: ordinary UI copy
 * actions and the Terminal's blocked-OSC notice call {@link copyText}. The
 * library chooses the Async Clipboard API on secure origins and a
 * hidden-selection `document.execCommand('copy')` on ordinary HTTP.
 *
 * ## User gesture
 *
 * Invoke {@link copyText} synchronously inside the click/key handler. The
 * library's HTTP branch runs its DOM copy during the call, before the returned
 * Promise settles; on a secure origin the async branch settles later. A caller
 * that awaits something else first may have spent the transient user
 * activation, and must not retry the legacy path from the rejection
 * continuation as though the gesture still existed.
 *
 * ## Automatic remote writes
 *
 * {@link writeTextProgrammatic} owns the non-gesture OSC 52 path. On a secure
 * origin it uses the Async Clipboard API directly so a permission rejection is
 * classified truthfully and no post-await legacy retry is attempted. On
 * ordinary HTTP it invokes `copy-to-clipboard`: Chromium may allow the
 * library's synchronous `execCommand` path without a fresh gesture, and the
 * actual browser result decides success or the truthful refusal. A remote
 * emission cannot manufacture user activation; Firefox/Safari may still refuse.
 *
 * ## Binary MIME
 *
 * {@link writeClipboardItem} owns OSC 5522's multi-MIME/binary item. The
 * selected library is text-only for arbitrary representations, so this owner
 * builds the standard `ClipboardItem` and writes it through the browser API.
 * Ordinary HTTP has no async Clipboard API; binary MIME is explicitly refused
 * (EPERM) there rather than pretending the text fallback can carry it. All
 * protocol-specific MIME negotiation and reply mapping stay in the Terminal
 * adapter.
 *
 * ## Truthful results
 *
 * `copyText` resolves `true` only when the browser reports the copy and
 * `false` when it refuses or the command is unsupported. {@link ClipboardWriteError}
 * carries the protocol's `EPERM`/`EIO` distinction for the automatic paths. The
 * library's `window.prompt` fallback is disabled: Nession keeps its own bounded
 * selectable-text surface instead.
 */
import copy from 'copy-to-clipboard';

/** The protocol's two truthful failure classes. */
export type ClipboardWriteErrorCode = 'EPERM' | 'EIO';

/** A clipboard write was refused or failed; the adapter maps this to a reply. */
export class ClipboardWriteError extends Error {
  constructor(readonly code: ClipboardWriteErrorCode) {
    super(code);
    this.name = 'ClipboardWriteError';
  }
}

function isPermissionError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

/** A BlobPart backed by a plain ArrayBuffer (never a shared one). */
function blobPart(bytes: Uint8Array): BlobPart {
  const copyBytes = new Uint8Array(bytes.byteLength);
  copyBytes.set(bytes);
  return copyBytes;
}

/** Copy text from a user gesture; `false` means the browser did not copy. */
export function copyText(text: string): Promise<boolean> {
  return copy(text, { fallbackToPrompt: false });
}

/**
 * Whether this origin can perform an **async** (non-gesture) clipboard write
 * (#2614, #2656).
 *
 * The Async Clipboard API is absent on ordinary HTTP. Automatic OSC 52 writes
 * still attempt the shared library's legacy path; this answer only describes
 * the async guarantee, so a surface must not use it to pre-reject an attempt.
 * A browser that exposes the API only to refuse still reports `true` here; the
 * refusal surfaces at call time as the truthful error.
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

/**
 * Automatic (non-gesture) OSC 52 text write (#2656 SC-06).
 *
 * Secure origins use the Async Clipboard API and classify its rejection; the
 * library is deliberately not used there because its post-await legacy retry
 * cannot rely on user activation. Insecure origins (and secure origins without
 * the async API) invoke the shared library's synchronous `execCommand` path,
 * whose actual browser result decides success. A refusal is `EPERM`.
 */
export async function writeTextProgrammatic(text: string): Promise<void> {
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!insecure && typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      throw new ClipboardWriteError(isPermissionError(error) ? 'EPERM' : 'EIO');
    }
  }

  let copied = false;
  try {
    copied = await copyText(text);
  } catch {
    throw new ClipboardWriteError('EIO');
  }
  if (!copied) {
    throw new ClipboardWriteError('EPERM');
  }
}

/**
 * Write one clipboard item carrying every requested MIME representation
 * (OSC 5522, #2656 SC-07).
 *
 * The one shared owner builds the standard `ClipboardItem` because the
 * selected text library cannot represent arbitrary binary MIME. Insecure
 * origins explicitly refuse (`EPERM`): the legacy text path must not silently
 * drop representations. Permission refusal maps to `EPERM`, other failures to
 * `EIO`.
 */
export async function writeClipboardItem(
  variants: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  const ClipboardItemCtor = (globalThis as Record<string, unknown>)['ClipboardItem'] as
    | typeof ClipboardItem
    | undefined;
  if (insecure || typeof clipboard?.write !== 'function'
    || ClipboardItemCtor === undefined || variants.size === 0) {
    throw new ClipboardWriteError('EPERM');
  }
  const record: Record<string, Blob> = {};
  for (const [type, bytes] of variants) {
    record[type] = new Blob([blobPart(bytes)], { type });
  }
  try {
    await clipboard.write([new ClipboardItemCtor(record)]);
  } catch (error) {
    throw new ClipboardWriteError(isPermissionError(error) ? 'EPERM' : 'EIO');
  }
}

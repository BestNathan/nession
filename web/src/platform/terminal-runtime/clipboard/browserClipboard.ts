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
 * `EPERM`, and the surface offers a **user-gesture** copy instead.
 *
 * That user-gesture text path is delegated to the shared browser clipboard
 * owner (`@/shared/lib/clipboard`, #2656), which integrates
 * `copy-to-clipboard`; this adapter keeps only the protocol-specific MIME
 * writes, capability detection and `EPERM`/`EIO` normalization.
 */
import {
  asyncClipboardWriteAvailable,
  copyText,
} from '@/shared/lib/clipboard';
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

  /**
   * The user-gesture text path (#2614), delegated to the shared owner (#2656).
   *
   * The returned Promise is the library's: its HTTP branch has already run the
   * DOM copy during this call, while its secure-origin branch settles after
   * the async write. Callers must invoke this inside the activating event.
   */
  writeTextFromGesture(text: string): Promise<boolean> {
    return copyText(text);
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

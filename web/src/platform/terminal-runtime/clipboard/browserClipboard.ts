/**
 * Browser Clipboard effect adapter for the terminal clipboard protocols (#2598).
 *
 * This adapter owns only protocol-specific work: OSC 52/5522 notices and
 * mapping the shared owner's `EPERM`/`EIO` result to the protocol reply. Every
 * browser clipboard write enters the one shared owner
 * (`@/shared/lib/clipboard`, #2656): user-gesture text copy, automatic OSC 52
 * text (including its library-backed HTTP legacy attempt), and OSC 5522's
 * multi-MIME/binary item. The adapter never calls `navigator.clipboard` or
 * `document.execCommand` itself.
 *
 * ## Ordinary HTTP is not a secure context (#2614)
 *
 * Browsers expose the async Clipboard API only on secure origins, so a page
 * served over plain HTTP (the deployed staging origin is one) has no
 * `navigator.clipboard`. Automatic OSC 52 writes still attempt the shared
 * library's synchronous legacy path (#2656 SC-06); the browser's actual result
 * decides whether the write succeeds silently or the surface offers the
 * user-gesture Copy notice. Binary OSC 5522 representations are explicitly
 * refused on HTTP because the text fallback cannot carry them.
 */
import {
  ClipboardWriteError,
  asyncClipboardWriteAvailable,
  copyText,
  writeClipboardItem,
  writeTextProgrammatic,
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

/** Map the shared owner's truthful failure to the protocol's reply class. */
function effectError(error: unknown): ClipboardEffectError {
  return error instanceof ClipboardWriteError
    ? new ClipboardEffectError(error.code)
    : new ClipboardEffectError('EIO');
}

export class BrowserClipboardEffects implements ClipboardEffectPort {
  constructor(private readonly options: BrowserClipboardOptions = {}) {}

  /** Whether the async (non-gesture) API is available on this origin. */
  writeTextIsProgrammatic(): boolean {
    return asyncClipboardWriteAvailable();
  }

  /**
   * The user-gesture text path, delegated to the shared owner.
   *
   * The returned Promise is the library's: its HTTP branch has already run the
   * DOM copy during this call, while its secure-origin branch settles after
   * the async write. Callers must invoke this inside the activating event.
   */
  writeTextFromGesture(text: string): Promise<boolean> {
    return copyText(text);
  }

  /** Automatic OSC 52 text write; the shared owner attempts HTTP legacy. */
  async writeText(text: string): Promise<void> {
    try {
      await writeTextProgrammatic(text);
    } catch (error) {
      throw effectError(error);
    }
  }

  /**
   * OSC 5522 multi-MIME/binary write, delegated to the one shared owner. Every
   * requested representation belongs to one clipboard item.
   */
  async writeClipboard(variants: ReadonlyMap<string, Uint8Array>): Promise<void> {
    try {
      await writeClipboardItem(variants);
    } catch (error) {
      throw effectError(error);
    }
  }

  notice(notice: ClipboardNotice): void {
    this.options.notice?.(notice);
  }
}

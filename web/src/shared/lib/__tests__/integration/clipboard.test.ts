// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

const { copy } = vi.hoisted(() => ({
  copy: vi.fn<(text: string, options?: unknown) => Promise<boolean>>(),
}));

vi.mock('copy-to-clipboard', () => ({ default: copy }));

import {
  ClipboardWriteError,
  asyncClipboardWriteAvailable,
  copyText,
  copyToClipboard,
  writeClipboardItem,
  writeTextProgrammatic,
} from '@/shared/lib/clipboard';

/** Present an async Clipboard API on the (otherwise API-less) jsdom navigator. */
function withClipboardApi(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
}

function withoutClipboardApi(): void {
  Reflect.deleteProperty(navigator, 'clipboard');
}

function withSecureContext(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

afterEach(() => {
  withoutClipboardApi();
  Reflect.deleteProperty(window, 'isSecureContext');
  copy.mockReset();
  vi.unstubAllGlobals();
});

describe('programmatic capability (#2614, #2656)', () => {
  it('is unavailable when the origin exposes no clipboard API (plain HTTP)', () => {
    withSecureContext(false);
    expect(asyncClipboardWriteAvailable()).toBe(false);
  });

  it('is available only with the API on a secure origin', () => {
    withSecureContext(true);
    withClipboardApi();
    expect(asyncClipboardWriteAvailable()).toBe(true);
    withSecureContext(false);
    expect(asyncClipboardWriteAvailable()).toBe(false);
  });

  it('treats a missing writeText on a secure origin as unavailable', () => {
    withSecureContext(true);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} });
    expect(asyncClipboardWriteAvailable()).toBe(false);
  });
});

describe('shared browser clipboard owner (#2656)', () => {
  it('invokes the library synchronously, inside the gesture task', () => {
    copy.mockResolvedValueOnce(true);
    const pending = copyText('hello');
    // The call is the activation contract: on plain HTTP the library runs its
    // execCommand path before its Promise settles, so an unrelated await
    // before this call would already have spent the gesture.
    expect(copy).toHaveBeenCalledWith('hello', { fallbackToPrompt: false });
    return expect(pending).resolves.toBe(true);
  });

  it('reports a refused copy as false rather than success', async () => {
    copy.mockResolvedValueOnce(false);
    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('keeps the rejecting UI contract over the library result', async () => {
    copy.mockResolvedValueOnce(false);
    await expect(copyToClipboard('hello')).rejects.toThrow();

    copy.mockResolvedValueOnce(true);
    await expect(copyToClipboard('hello')).resolves.toBeUndefined();
    expect(copy).toHaveBeenCalledWith('hello', { fallbackToPrompt: false });
  });
});

describe('automatic write path (#2656 SC-06)', () => {
  it('uses the async API on a secure origin and never falls back after rejection', async () => {
    withSecureContext(true);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await expect(writeTextProgrammatic('hello')).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(copy).not.toHaveBeenCalled();

    writeText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await expect(writeTextProgrammatic('hello')).rejects.toMatchObject({ code: 'EPERM' });
    expect(copy, 'no post-await legacy retry on a secure origin').not.toHaveBeenCalled();
  });

  it('maps a non-permission async failure to EIO', async () => {
    withSecureContext(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('boom'); }) },
    });
    await expect(writeTextProgrammatic('hello')).rejects.toMatchObject({ code: 'EIO' });
  });

  it('attempts the shared library on an insecure origin without a gesture', async () => {
    withSecureContext(false);
    copy.mockResolvedValueOnce(true);

    await expect(writeTextProgrammatic('hello')).resolves.toBeUndefined();
    expect(copy).toHaveBeenCalledWith('hello', { fallbackToPrompt: false });
  });

  it('reports a refused legacy copy as EPERM', async () => {
    withSecureContext(false);
    copy.mockResolvedValue(false);

    await expect(writeTextProgrammatic('hello'))
      .rejects.toBeInstanceOf(ClipboardWriteError);
    await expect(writeTextProgrammatic('hello'))
      .rejects.toMatchObject({ code: 'EPERM' });
  });
});

describe('shared clipboard item owner (#2656 SC-07)', () => {
  const variants = (): ReadonlyMap<string, Uint8Array> => new Map([
    ['text/plain', new TextEncoder().encode('hello')],
    ['image/png', new Uint8Array([1, 2, 3])],
  ]);

  class FakeClipboardItem {
    constructor(readonly record: Record<string, Blob>) {}
  }

  it('writes every requested MIME representation in one item', async () => {
    withSecureContext(true);
    const write = vi.fn<(items: FakeClipboardItem[]) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);

    await expect(writeClipboardItem(variants())).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0][0];
    expect(item.record['text/plain']).toBeInstanceOf(Blob);
    expect(item.record['image/png']).toBeInstanceOf(Blob);
    expect(item.record['text/plain'].type).toBe('text/plain');
    expect(item.record['image/png'].type).toBe('image/png');
  });

  it('explicitly refuses binary MIME on an insecure origin', async () => {
    withSecureContext(false);
    await expect(writeClipboardItem(variants())).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('explicitly refuses when the browser exposes no clipboard-item write', async () => {
    withSecureContext(true);
    await expect(writeClipboardItem(variants())).rejects.toMatchObject({ code: 'EPERM' });
  });

  it('maps permission refusal and other failures truthfully', async () => {
    withSecureContext(true);
    const write = vi.fn<(items: FakeClipboardItem[]) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);

    write.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await expect(writeClipboardItem(variants())).rejects.toMatchObject({ code: 'EPERM' });

    write.mockRejectedValueOnce(new Error('boom'));
    await expect(writeClipboardItem(variants())).rejects.toMatchObject({ code: 'EIO' });
  });
});

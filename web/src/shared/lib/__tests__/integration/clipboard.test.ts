// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

const { copy } = vi.hoisted(() => ({
  copy: vi.fn<(text: string, options?: unknown) => Promise<boolean>>(),
}));

vi.mock('copy-to-clipboard', () => ({ default: copy }));

import {
  asyncClipboardWriteAvailable,
  copyText,
  copyToClipboard,
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

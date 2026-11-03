// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const { copyText } = vi.hoisted(() => ({
  copyText: vi.fn<(text: string) => Promise<boolean>>(),
}));

vi.mock('@/shared/lib/clipboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/clipboard')>();
  return { ...actual, copyText };
});

import {
  BrowserClipboardEffects,
} from '@/platform/terminal-runtime/clipboard/browserClipboard';

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
  copyText.mockReset();
  vi.restoreAllMocks();
});

describe('user-gesture copy delegation (#2656)', () => {
  it('delegates to the shared owner and returns its result', async () => {
    copyText.mockResolvedValueOnce(true);
    const effects = new BrowserClipboardEffects();
    await expect(effects.writeTextFromGesture('remote text')).resolves.toBe(true);
    expect(copyText).toHaveBeenCalledWith('remote text');
  });

  it('reports a refused copy truthfully', async () => {
    copyText.mockResolvedValueOnce(false);
    const effects = new BrowserClipboardEffects();
    await expect(effects.writeTextFromGesture('remote text')).resolves.toBe(false);
  });

  it('keeps the programmatic capability answer independent of the gesture path', () => {
    withSecureContext(false);
    expect(new BrowserClipboardEffects().writeTextIsProgrammatic()).toBe(false);
    withSecureContext(true);
    withClipboardApi();
    expect(new BrowserClipboardEffects().writeTextIsProgrammatic()).toBe(true);
  });
});

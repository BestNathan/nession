// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const { copyText, writeClipboardItem, writeTextProgrammatic } = vi.hoisted(() => ({
  copyText: vi.fn<(text: string) => Promise<boolean>>(),
  writeTextProgrammatic: vi.fn<(text: string) => Promise<void>>(),
  writeClipboardItem: vi.fn<(variants: ReadonlyMap<string, Uint8Array>) => Promise<void>>(),
}));

vi.mock('@/shared/lib/clipboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/clipboard')>();
  return { ...actual, copyText, writeClipboardItem, writeTextProgrammatic };
});

import {
  ClipboardWriteError,
} from '@/shared/lib/clipboard';
import {
  BrowserClipboardEffects,
} from '@/platform/terminal-runtime/clipboard/browserClipboard';
import { ClipboardEffectError } from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';

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
  writeTextProgrammatic.mockReset();
  writeClipboardItem.mockReset();
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

describe('automatic text delegation (#2656 SC-06)', () => {
  it('delegates the non-gesture write to the shared owner', async () => {
    writeTextProgrammatic.mockResolvedValueOnce(undefined);
    const effects = new BrowserClipboardEffects();
    await expect(effects.writeText('remote text')).resolves.toBeUndefined();
    expect(writeTextProgrammatic).toHaveBeenCalledWith('remote text');
  });

  it('maps a shared permission refusal to EPERM', async () => {
    writeTextProgrammatic.mockRejectedValueOnce(new ClipboardWriteError('EPERM'));
    const effects = new BrowserClipboardEffects();
    await expect(effects.writeText('remote text')).rejects.toMatchObject({
      name: 'ClipboardEffectError',
      code: 'EPERM',
    });
  });

  it('maps a shared I/O failure to EIO', async () => {
    writeTextProgrammatic.mockRejectedValue(new ClipboardWriteError('EIO'));
    const effects = new BrowserClipboardEffects();
    await expect(effects.writeText('remote text')).rejects.toBeInstanceOf(ClipboardEffectError);
    await expect(effects.writeText('remote text')).rejects.toMatchObject({ code: 'EIO' });
  });

  it('maps an unexpected shared-owner failure to EIO', async () => {
    writeTextProgrammatic.mockRejectedValueOnce(new Error('boom'));
    const effects = new BrowserClipboardEffects();
    await expect(effects.writeText('remote text')).rejects.toMatchObject({ code: 'EIO' });
  });
});

describe('clipboard-item delegation (#2656 SC-07)', () => {
  const variants = (): ReadonlyMap<string, Uint8Array> => new Map([
    ['image/png', new Uint8Array([1, 2, 3])],
  ]);

  it('delegates MIME writes to the shared owner', async () => {
    writeClipboardItem.mockResolvedValueOnce(undefined);
    const effects = new BrowserClipboardEffects();
    await expect(effects.writeClipboard(variants())).resolves.toBeUndefined();
    expect(writeClipboardItem).toHaveBeenCalledWith(variants());
  });

  it('maps a shared refusal to EPERM and an I/O failure to EIO', async () => {
    const effects = new BrowserClipboardEffects();

    writeClipboardItem.mockRejectedValueOnce(new ClipboardWriteError('EPERM'));
    await expect(effects.writeClipboard(variants())).rejects.toMatchObject({ code: 'EPERM' });

    writeClipboardItem.mockRejectedValueOnce(new ClipboardWriteError('EIO'));
    await expect(effects.writeClipboard(variants())).rejects.toMatchObject({ code: 'EIO' });
  });
});

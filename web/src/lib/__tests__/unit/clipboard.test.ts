import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyToClipboard } from '@/lib/clipboard';

describe('copyToClipboard', () => {
  const originalExecCommand = document.execCommand;

  afterEach(() => {
    // Restore navigator.clipboard and document.execCommand.
    delete (navigator as { clipboard?: unknown }).clipboard;
    document.execCommand = originalExecCommand;
    vi.restoreAllMocks();
  });

  it('uses the async Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await copyToClipboard('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when navigator.clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });

    let captured = '';
    document.execCommand = vi.fn().mockImplementation(() => {
      captured = document.body.querySelector('textarea')?.value ?? '';
      return true;
    });

    await copyToClipboard('hello');

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(captured).toBe('hello');
  });

  it('rejects when the fallback execCommand fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    document.execCommand = vi.fn().mockReturnValue(false);

    await expect(copyToClipboard('hello')).rejects.toThrow();
  });
});

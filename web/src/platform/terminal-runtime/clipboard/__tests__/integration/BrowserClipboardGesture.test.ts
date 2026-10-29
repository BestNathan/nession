// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserClipboardEffects,
  asyncClipboardWriteAvailable,
  copyTextFromUserGesture,
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

function installCopyCommand(behavior: 'deliver' | 'refuse' | 'throw'): ReturnType<typeof vi.fn> {
  const command = vi.fn(() => {
    if (behavior === 'throw') {
      throw new Error('copy is not supported');
    }
    if (behavior === 'deliver') {
      const event = new Event('copy', { bubbles: true, cancelable: true }) as Event & {
        clipboardData?: { setData: (type: string, data: string) => void };
      };
      event.clipboardData = { setData };
      document.dispatchEvent(event);
      return true;
    }
    return false;
  });
  document.execCommand = command as unknown as typeof document.execCommand;
  return command;
}

const setData = vi.fn<(type: string, data: string) => void>();

afterEach(() => {
  withoutClipboardApi();
  Reflect.deleteProperty(window, 'isSecureContext');
  Reflect.deleteProperty(document, 'execCommand');
  setData.mockReset();
  vi.restoreAllMocks();
});

describe('async clipboard capability (#2614)', () => {
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

describe('user-gesture copy fallback (#2614)', () => {
  it('delivers the exact text through the copy command', () => {
    const command = installCopyCommand('deliver');
    expect(copyTextFromUserGesture('remote text')).toBe(true);
    expect(command).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledWith('text/plain', 'remote text');
  });

  it('is false when the command is refused, and leaves no listener behind', () => {
    installCopyCommand('refuse');
    expect(copyTextFromUserGesture('remote text')).toBe(false);
    // A later copy event is the page's own business, not a stale handler's.
    const later = new Event('copy', { bubbles: true, cancelable: true }) as Event & {
      clipboardData?: { setData: (type: string, data: string) => void };
    };
    later.clipboardData = { setData };
    document.dispatchEvent(later);
    expect(setData).not.toHaveBeenCalled();
  });

  it('is false when the command throws or does not exist', () => {
    installCopyCommand('throw');
    expect(copyTextFromUserGesture('remote text')).toBe(false);
    Reflect.deleteProperty(document, 'execCommand');
    expect(copyTextFromUserGesture('remote text')).toBe(false);
  });

  it('is offered by the browser effects adapter with the same capability answer', () => {
    installCopyCommand('deliver');
    withSecureContext(true);
    withClipboardApi();
    const effects = new BrowserClipboardEffects();
    expect(effects.writeTextIsProgrammatic()).toBe(true);
    expect(effects.writeTextFromGesture('effects text')).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'effects text');
    withSecureContext(false);
    expect(effects.writeTextIsProgrammatic()).toBe(false);
  });
});

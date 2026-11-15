import { describe, expect, it } from 'vitest';
import {
  APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE,
  APP_VIEWPORT_SNAPSHOT_EVENT,
  isEditableElement,
  readPublishedAppViewport,
  type AppSafeArea,
  type AppViewportSnapshot,
  type ViewportRect,
  type VisualViewportReading,
} from '@/platform/viewport/appViewport';
import {
  AppViewportEnvironment,
  type AppViewportEnvironmentHost,
} from '@/platform/viewport/AppViewportEnvironment';

class FakeHost implements AppViewportEnvironmentHost {
  layout: ViewportRect = { left: 0, top: 0, width: 390, height: 844 };
  visual: VisualViewportReading | null = { offsetLeft: 0, offsetTop: 0, width: 390, height: 844, scale: 1 };
  focus = false;
  safeArea: AppSafeArea = { top: 0, right: 0, bottom: 0, left: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly frames = new Map<number, () => void>();
  private nextFrame = 1;
  subscribeCalls = 0;

  readLayoutBounds(): ViewportRect {
    return { ...this.layout };
  }

  readVisualViewport(): VisualViewportReading | null {
    return this.visual === null ? null : { ...this.visual };
  }

  readEditableFocus(): boolean {
    return this.focus;
  }

  readSafeArea(): AppSafeArea {
    return { ...this.safeArea };
  }

  subscribe(onChange: () => void): () => void {
    this.subscribeCalls += 1;
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  scheduleFrame(callback: () => void): number {
    const handle = this.nextFrame;
    this.nextFrame += 1;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.frames.delete(handle);
  }

  /** Deliver one browser-like viewport/focus notification. */
  emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  flushFrames(): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const frame of pending) {
      frame();
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

function mountEnvironment() {
  const shell = document.createElement('div');
  document.body.appendChild(shell);
  shell.setAttribute(APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE, '');
  const host = new FakeHost();
  const environment = new AppViewportEnvironment(shell, host);
  return { shell, host, environment };
}

describe('AppViewportEnvironment', () => {
  it('publishes one snapshot per frame with the observable contract', () => {
    const { shell, host, environment } = mountEnvironment();
    const published: AppViewportSnapshot[] = [];
    shell.addEventListener(APP_VIEWPORT_SNAPSHOT_EVENT, (event) => {
      published.push((event as CustomEvent<AppViewportSnapshot>).detail);
    });
    environment.start();
    expect(host.listenerCount, 'one browser subscription owns all inputs').toBe(1);
    expect(environment.current(), 'coalesced until the frame runs').toBeNull();
    host.flushFrames();
    expect(published).toHaveLength(1);
    expect(shell.dataset.appVisibleHeight).toBe('844');
    expect(shell.dataset.appOccludedBottom).toBe('0');
    expect(shell.dataset.appKeyboard).toBe('closed');
    expect(shell.style.getPropertyValue('--nession-app-visible-bottom')).toBe('844px');
    expect(readPublishedAppViewport(shell)?.revision).toBe(1);
    expect(environment.current()?.revision).toBe(1);
  });

  it('coalesces several inputs into one publish and drops equivalent readings', () => {
    const { shell, host, environment } = mountEnvironment();
    let publishes = 0;
    environment.subscribe(() => { publishes += 1; });
    environment.start();
    host.flushFrames();
    expect(publishes).toBe(1);

    host.emit();
    host.emit();
    host.emit();
    host.flushFrames();
    expect(publishes, 'an unchanged viewport is not republished').toBe(1);
    expect(shell.dataset.appViewportRevision).toBe('1');

    host.visual = { offsetLeft: 0, offsetTop: 0, width: 390, height: 844, scale: 1 };
    host.focus = true;
    host.emit();
    host.flushFrames();
    expect(publishes, 'focus alone does not invent a keyboard').toBe(2);
    expect(shell.dataset.appKeyboard).toBe('closed');

    host.visual = { offsetLeft: 0, offsetTop: 0, width: 390, height: 544, scale: 1 };
    host.emit();
    host.flushFrames();
    expect(publishes, 'editable focus plus reduced visibility is actionable').toBe(3);
    expect(shell.dataset.appKeyboard).toBe('open');
    expect(shell.dataset.appOccludedBottom).toBe('300');
    expect(shell.dataset.appVisibleHeight).toBe('544');
    expect(shell.dataset.appViewportRevision).toBe('3');
  });

  it('publishes safe-area and layout/visible geometry as separate facts', () => {
    const { shell, host, environment } = mountEnvironment();
    host.layout = { left: 10, top: 24, width: 390, height: 820 };
    host.visual = { offsetLeft: 10, offsetTop: 24, width: 390, height: 820, scale: 1 };
    host.safeArea = { top: 44, right: 0, bottom: 34, left: 0 };
    environment.start();
    host.flushFrames();
    const snapshot = readPublishedAppViewport(shell);
    expect(snapshot?.layoutBounds).toEqual({ left: 10, top: 24, width: 390, height: 820 });
    expect(snapshot?.visibleBounds).toEqual({ left: 0, top: 0, width: 390, height: 820 });
    expect(snapshot?.safeArea).toEqual({ top: 44, right: 0, bottom: 34, left: 0 });
    expect(shell.dataset.appSafeAreaBottom).toBe('34');
    expect(shell.style.getPropertyValue('--nession-app-safe-area-top')).toBe('44px');
  });

  it('stops listening when the Experience unmounts', () => {
    const { shell, host, environment } = mountEnvironment();
    environment.start();
    host.flushFrames();
    environment.stop();
    expect(host.listenerCount).toBe(0);
    expect(shell.hasAttribute(APP_VIEWPORT_ENVIRONMENT_ATTRIBUTE)).toBe(false);
    host.emit();
    host.flushFrames();
    expect(environment.current(), 'no publish after teardown').not.toBeNull();
  });

  it('does not publish when the missing API is replaced by an equivalent layout', () => {
    const { shell, host, environment } = mountEnvironment();
    host.visual = null;
    environment.start();
    host.flushFrames();
    const first = readPublishedAppViewport(shell)?.revision;
    host.visual = { offsetLeft: 0, offsetTop: 0, width: 390, height: 844, scale: 1 };
    host.emit();
    host.flushFrames();
    expect(readPublishedAppViewport(shell)?.revision).toBe(first);
  });
});

describe('isEditableElement', () => {
  it('accepts editable controls and rejects non-editable ones', () => {
    const textarea = document.createElement('textarea');
    const input = document.createElement('input');
    const search = document.createElement('input');
    search.type = 'search';
    const button = document.createElement('button');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const readonly = document.createElement('input');
    readonly.readOnly = true;
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');

    expect(isEditableElement(textarea)).toBe(true);
    expect(isEditableElement(input)).toBe(true);
    expect(isEditableElement(search)).toBe(true);
    expect(isEditableElement(editable)).toBe(true);
    expect(isEditableElement(button)).toBe(false);
    expect(isEditableElement(checkbox)).toBe(false);
    expect(isEditableElement(readonly)).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { ComposerLayout } from '@/session-first/capsule/types';

export const FLIP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const FLIP_MS = 260;

let flipGeneration = 0;
let pendingRafId: number | null = null;

/** Resets module-level FLIP scheduling state (unit tests only). */
export function _resetLayoutFlipForTests(): void {
  flipGeneration += 1;
  if (pendingRafId !== null) {
    cancelAnimationFrame(pendingRafId);
    pendingRafId = null;
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface FlipTarget {
  el: HTMLElement;
  first: DOMRect;
}

function clearFlipInlineStyles(el: HTMLElement): void {
  el.style.transition = '';
  el.style.transform = '';
}

function scheduleFlipCleanup(
  els: HTMLElement[],
  durationMs: number,
  generation: number,
): void {
  if (els.length === 0) {
    return;
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned || generation !== flipGeneration) {
      return;
    }
    cleaned = true;
    for (const el of els) {
      clearFlipInlineStyles(el);
    }
  };

  let pendingEnds = els.length;
  const onTransitionEnd = (event: Event) => {
    const te = event as TransitionEvent;
    if (te.propertyName !== 'transform') {
      return;
    }
    pendingEnds -= 1;
    if (pendingEnds <= 0) {
      cleanup();
    }
  };

  for (const el of els) {
    el.addEventListener('transitionend', onTransitionEnd);
  }

  window.setTimeout(() => {
    for (const el of els) {
      el.removeEventListener('transitionend', onTransitionEnd);
    }
    cleanup();
  }, durationMs + 16);
}

export function runLayoutFlip(
  targets: FlipTarget[],
  opts: { durationMs?: number } = {},
): void {
  if (prefersReducedMotion() || targets.length === 0) {
    return;
  }

  flipGeneration += 1;
  const generation = flipGeneration;

  if (pendingRafId !== null) {
    cancelAnimationFrame(pendingRafId);
    pendingRafId = null;
  }

  const durationMs = opts.durationMs ?? FLIP_MS;
  const toPlay: HTMLElement[] = [];

  for (const { el } of targets) {
    el.style.transition = 'none';
  }

  for (const { el, first } of targets) {
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0) {
      clearFlipInlineStyles(el);
      continue;
    }
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    toPlay.push(el);
  }

  if (toPlay.length === 0) {
    for (const { el } of targets) {
      clearFlipInlineStyles(el);
    }
    return;
  }

  // Force layout before enabling transition
  void document.body.offsetHeight;

  pendingRafId = requestAnimationFrame(() => {
    pendingRafId = null;
    if (generation !== flipGeneration) {
      return;
    }

    for (const el of toPlay) {
      el.style.transition = `transform ${durationMs}ms ${FLIP_EASE}`;
      el.style.transform = '';
    }

    scheduleFlipCleanup(toPlay, durationMs, generation);
  });
}

/**
 * Call `captureBeforeLayoutChange()` before layout DOM change; after React commits
 * new layout, FLIP runs on `[data-flip-id]` elements under `rootRef`.
 */
export function useCapsuleLayoutFlip(
  layout: ComposerLayout,
  rootRef: RefObject<HTMLElement | null>,
): { captureBeforeLayoutChange: () => void } {
  const pendingFirst = useRef<Map<string, DOMRect> | null>(null);
  const prevLayout = useRef(layout);

  const captureBeforeLayoutChange = () => {
    const root = rootRef.current;
    if (!root || prefersReducedMotion()) {
      pendingFirst.current = null;
      return;
    }
    const map = new Map<string, DOMRect>();
    root.querySelectorAll<HTMLElement>('[data-flip-id]').forEach((el) => {
      const id = el.dataset.flipId;
      if (id) {
        map.set(id, el.getBoundingClientRect());
      }
    });
    pendingFirst.current = map;
  };

  useLayoutEffect(() => {
    if (prevLayout.current === layout) {
      return;
    }
    prevLayout.current = layout;
    const root = rootRef.current;
    const firsts = pendingFirst.current;
    pendingFirst.current = null;
    if (!root || !firsts) {
      return;
    }
    const targets: FlipTarget[] = [];
    firsts.forEach((first, id) => {
      const el = root.querySelector<HTMLElement>(`[data-flip-id="${id}"]`);
      if (el) {
        targets.push({ el, first });
      }
    });
    runLayoutFlip(targets);
  }, [layout, rootRef]);

  return { captureBeforeLayoutChange };
}

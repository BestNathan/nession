import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  runLayoutFlip,
  type FlipTarget,
} from '@/product/terminal/capsule/useCapsuleLayoutFlip';

/**
 * The attribute the cross-surface morph keys on.
 *
 * Deliberately NOT `data-flip-id`: that one belongs to `useCapsuleLayoutFlip`,
 * the intra-capsule composer FLIP, whose root is the capsule dock. Reusing it
 * would make each mechanism capture the other's elements — the composer FLIP
 * would translate the whole shell on multiline growth, and the morph would
 * drag the tool rows across a surface switch they are not part of.
 */
const MORPH_ATTR = 'data-morph-id';

/**
 * Cross-surface reciprocal morph (#1347 SC-08).
 *
 * Terminal draws the capsule zone as `[capsule][circle]`; Workspace draws it as
 * `[circle][capsule]` — the same two elements in mirror positions. This hook
 * makes a surface switch read as those elements sliding to their reciprocal
 * places rather than one bar vanishing and another appearing.
 *
 * How: both surfaces stay mounted (the inactive one is `display: none`), so
 * after every commit the hook remembers where each *visible*
 * `[data-morph-id]` element is. When `surfaceKey` changes, the stored rects
 * are the First of a FLIP on the surface the user was looking at, and the
 * newly visible elements bearing the same ids are its Last. `runLayoutFlip`
 * does the invert-and-play; it already no-ops under
 * `prefers-reduced-motion: reduce`, so the morph degrades to the instant
 * switch there.
 *
 * Elements are keyed by id, not by element identity: the Terminal's capsule
 * shell and the Workspace's capability capsule share `data-morph-id`
 * `"capsule-shell"`, and the two destination actions share `"surface-action"`,
 * because that is what makes the morph *reciprocal* — each element animates
 * from the other's former place. Hidden (zero-rect) elements are ignored in
 * both passes, so the dormant surface never becomes a source or a target.
 */
export function useCapsuleMorph(
  surfaceKey: string,
  rootRef: RefObject<HTMLElement | null>,
): void {
  const visibleRects = useRef<Map<string, DOMRect>>(new Map());
  const prevKey = useRef(surfaceKey);

  // No dependency array, on purpose: the tracked rects must refresh after
  // EVERY commit, not only when the surface changes, or a switch measured
  // against rects from several commits ago would animate from a place the
  // element has already left.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    if (prevKey.current !== surfaceKey) {
      prevKey.current = surfaceKey;
      const targets: FlipTarget[] = [];
      const settled = new Map<string, DOMRect>();
      visibleRects.current.forEach((first, id) => {
        root
          .querySelectorAll<HTMLElement>(`[${MORPH_ATTR}="${id}"]`)
          .forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0) {
              targets.push({ el, first });
              settled.set(id, rect);
            }
          });
      });
      // Record the new surface's resting rects BEFORE runLayoutFlip applies
      // its invert transforms: a rect read after them includes the transform,
      // and storing that poisons the return switch — measured live, the
      // workspace→terminal morph replayed the animation's *start* as the
      // resting place, computed a zero delta, and silently did nothing.
      visibleRects.current = settled;
      runLayoutFlip(targets);
      return;
    }

    const next = new Map<string, DOMRect>();
    root.querySelectorAll<HTMLElement>(`[${MORPH_ATTR}]`).forEach((el) => {
      const id = el.dataset.morphId;
      if (!id) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        next.set(id, rect);
      }
    });
    visibleRects.current = next;
  });
}

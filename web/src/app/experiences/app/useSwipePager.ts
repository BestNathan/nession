import { useCallback, useRef, useState, type TouchEvent } from 'react';
import { edgeBandSide, edgeOwnsDrag, type EdgeSide, type ShellBounds } from './edgeBand';
import { SWIPE_COMMIT_PX } from './gesture';
import { isWorkSurface } from './workSurface';

export interface UseSwipePagerArgs {
  pageCount: number;
  index: number;
  onIndexChange: (index: number) => void;
  /**
   * The shell's horizontal extent in client coordinates, read once per touch —
   * the frame the edge band is measured from (#1081). A callback rather than a
   * value because the shell can move and resize, and a `null` return means the
   * shell cannot say where its edges are; a touch inside a work surface then
   * does not start a page, since the surface wins when the shell cannot show
   * the touch was at its edge.
   */
  getShellBounds: () => ShellBounds | null;
  /**
   * Whether the shell may claim a horizontal drag on this layer at all (#1081).
   *
   * False while the layer's own depth is offering a leave. The App has one such
   * depth: a pushed Workspace detail, whose page header's Back is that depth's
   * single leave (#1051) and — unlike the shell's leave — is allowed to refuse.
   * `FilesAppLayout`'s handler is dirty-aware and opens a discard dialog for an
   * unsaved editor; the shell's leave is not, so the two must not both be
   * reachable.
   *
   * Declining the drag here, rather than suppressing the commit, is what keeps
   * the two from being reachable at once: nothing follows the finger, so there
   * is no page to snap back from and no ambiguous half-gesture. Measured on the
   * fixture, the shell's rightward page is the only one that *can* commit from
   * the Workspace layer — a leftward drag runs off the end of the pager — so
   * this removes the competing route and nothing else.
   */
  shellMayPage: boolean;
}

/** What gate 2 makes of a touch, before anything has moved. */
type StartClaim = { page: true; edge: EdgeSide | null } | { page: false };

/**
 * Gate 2: where on this layer a page may begin, if at all.
 *
 * Two different questions land on `page: false` and both belong here — a touch
 * inside a work surface is the surface's, and a shell that cannot report its
 * own edges cannot show the touch was at one, so the surface wins that tie too.
 * `getBounds` is called only where it is needed, so a touch on shell chrome
 * costs no layout read.
 */
function claimAtStart(
  target: EventTarget | null,
  clientX: number,
  getBounds: () => ShellBounds | null,
): StartClaim {
  if (!isWorkSurface(target)) {
    return { page: true, edge: null };
  }
  const bounds = getBounds();
  const edge = bounds === null ? null : edgeBandSide(clientX, bounds);
  return edge === null ? { page: false } : { page: true, edge };
}

/**
 * The App's top-level pager.
 *
 * Three gates decide whether a touch becomes a page, and each answers a
 * different question. None replaces another:
 *
 * 1. **May the shell claim this drag at all?** `shellMayPage` — false on a
 *    layer whose own depth offers a leave, so the shell does not compete with
 *    it (#1081, #1051). See that argument's own note.
 * 2. **Where on this layer may a page begin?** The work-surface exclusion, as
 *    `workSurface.ts` states it and `edgeBand.ts` bounds it: the surface owns
 *    the touches that begin in it, except within `EDGE_BAND_PX` of a shell edge
 *    and only in the direction that edge's layer arrives from (#1049, #1081).
 * 3. **Is a begun drag a page or a scroll?** The axis lock in `onTouchMove`,
 *    which decides *after* a touch has been captured and therefore cannot
 *    answer either question above.
 */
export function useSwipePager({
  pageCount,
  index,
  onIndexChange,
  getShellBounds,
  shellMayPage,
}: UseSwipePagerArgs): {
  dragOffset: number;
  isDragging: boolean;
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
} {
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const activeRef = useRef(false);
  const cancelledRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const dragOffsetRef = useRef(0);
  // #1081. The shell edge this gesture started from, or `null` when it began on
  // shell chrome and is therefore unconstrained. The band constrains the whole
  // drag rather than its opening move — see `onTouchMove`.
  const edgeRef = useRef<EdgeSide | null>(null);
  const indexRef = useRef(index);
  const pageCountRef = useRef(pageCount);
  const onIndexChangeRef = useRef(onIndexChange);
  const getShellBoundsRef = useRef(getShellBounds);

  indexRef.current = index;
  pageCountRef.current = pageCount;
  onIndexChangeRef.current = onIndexChange;
  getShellBoundsRef.current = getShellBounds;

  const reset = useCallback(() => {
    activeRef.current = false;
    cancelledRef.current = false;
    edgeRef.current = null;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsDragging(false);
  }, []);

  // Give the gesture up for good: whatever took it — the surface's own scroll,
  // or an edge band that the drag does not belong to — keeps it, and no later
  // move in this touch can revive it. Distinct from `reset`, which ends a
  // gesture and so must also clear `cancelledRef` for the next one.
  const surrender = useCallback(() => {
    cancelledRef.current = true;
    activeRef.current = false;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsDragging(false);
  }, []);

  const onTouchStart = useCallback((e: TouchEvent) => {
    // Gate 1. See the note above the hook.
    if (!shellMayPage) {
      return;
    }

    const touch = e.touches[0];
    if (!touch) {
      return;
    }

    const claim = claimAtStart(e.target, touch.clientX, getShellBoundsRef.current);
    if (!claim.page) {
      return;
    }

    // Written only on a start: a second touch landing mid-drag must not clear
    // the edge the first one is still bound by.
    edgeRef.current = claim.edge;
    activeRef.current = true;
    cancelledRef.current = false;
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsDragging(true);
  }, [shellMayPage]);

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!activeRef.current || cancelledRef.current) {
        return;
      }

      const touch = e.touches[0];
      if (!touch) {
        return;
      }

      const dx = touch.clientX - startXRef.current;
      const dy = touch.clientY - startYRef.current;

      if (Math.abs(dy) > Math.abs(dx)) {
        surrender();
        return;
      }

      // Gate 2's direction half. Tested against the *net* offset on every move
      // rather than locked on the opening move, because the offset is what
      // commits: a lock would let a drag that starts at the left edge, turns
      // round and ends 200px to the left commit the layer the opposite edge
      // owns. See `edgeOwnsDrag`.
      const edge = edgeRef.current;
      if (edge !== null && dx !== 0 && !edgeOwnsDrag(edge, dx)) {
        surrender();
        return;
      }

      dragOffsetRef.current = dx;
      setDragOffset(dx);
    },
    [surrender],
  );

  const onTouchEnd = useCallback(() => {
    if (!activeRef.current || cancelledRef.current) {
      reset();
      return;
    }

    const offset = dragOffsetRef.current;
    if (Math.abs(offset) >= SWIPE_COMMIT_PX) {
      const current = indexRef.current;
      const next = offset > 0 ? current - 1 : current + 1;
      if (next >= 0 && next < pageCountRef.current) {
        onIndexChangeRef.current(next);
      }
    }

    reset();
  }, [reset]);

  const onTouchCancel = useCallback(() => {
    reset();
  }, [reset]);

  return {
    dragOffset,
    isDragging,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  };
}

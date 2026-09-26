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
}

export function useSwipePager({
  pageCount,
  index,
  onIndexChange,
  getShellBounds,
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

  // A drag may start anywhere on the shell chrome, and at the shell's own edges
  // even over a work surface: a touch that lands in the terminal viewport, an
  // editor, a field, or the capsule belongs to that surface *except* within
  // `EDGE_BAND_PX` of a shell edge, where the shell may still claim a page
  // (#1049 decision 1, re-admitted and bounded by #1081).
  //
  // The axis lock in `onTouchMove` still runs. The two discriminate different
  // things — the gate says *where navigation may begin*, the lock says whether
  // a begun drag is a page or a scroll — and neither replaces the other.
  const onTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) {
      return;
    }

    // Only computed when the surface would otherwise decline, so the common
    // case costs no layout read.
    let edge: EdgeSide | null = null;
    if (isWorkSurface(e.target)) {
      const bounds = getShellBoundsRef.current();
      edge = bounds === null ? null : edgeBandSide(touch.clientX, bounds);
      if (edge === null) {
        return;
      }
    }

    // Written only on the path that actually starts a gesture: a second touch
    // landing on a work surface mid-drag must not clear the edge that the first
    // one is still bound by.
    edgeRef.current = edge;
    activeRef.current = true;
    cancelledRef.current = false;
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsDragging(true);
  }, []);

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

      // #1081. A drag that began in an edge band over a work surface belongs to
      // the shell only while it moves the way that edge's layer arrives: the
      // left band pulls Sessions in (rightward), the right band pulls Workspace
      // in (leftward).
      //
      // Tested against the *net* offset on every move rather than locked on the
      // opening move. A lock reads tidier — it matches the axis lock above — but
      // it would let a drag that starts at the left edge, turns round, and ends
      // 200px to the left commit **Workspace**, which is the layer the opposite
      // edge owns. The offset is what commits, so the offset is what the edge
      // has to own. Crossing zero is the user reversing, and the shell then
      // gives the gesture up rather than committing either layer.
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

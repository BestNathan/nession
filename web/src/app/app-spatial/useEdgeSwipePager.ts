import { useCallback, useRef, useState, type TouchEvent } from 'react';
import { EDGE_BAND_PX, SWIPE_COMMIT_PX } from './edgeBand';

export interface UseEdgeSwipePagerArgs {
  pageCount: number;
  index: number;
  onIndexChange: (index: number) => void;
  width: number;
}

export function useEdgeSwipePager({
  pageCount,
  index,
  onIndexChange,
  width,
}: UseEdgeSwipePagerArgs): {
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
  const indexRef = useRef(index);
  const pageCountRef = useRef(pageCount);
  const onIndexChangeRef = useRef(onIndexChange);

  indexRef.current = index;
  pageCountRef.current = pageCount;
  onIndexChangeRef.current = onIndexChange;

  const reset = useCallback(() => {
    activeRef.current = false;
    cancelledRef.current = false;
    dragOffsetRef.current = 0;
    setDragOffset(0);
    setIsDragging(false);
  }, []);

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) {
        return;
      }

      const x = touch.clientX;
      const inLeftEdge = x <= EDGE_BAND_PX;
      const inRightEdge = x >= width - EDGE_BAND_PX;
      if (!inLeftEdge && !inRightEdge) {
        activeRef.current = false;
        return;
      }

      activeRef.current = true;
      cancelledRef.current = false;
      startXRef.current = x;
      startYRef.current = touch.clientY;
      dragOffsetRef.current = 0;
      setDragOffset(0);
      setIsDragging(true);
    },
    [width],
  );

  const onTouchMove = useCallback((e: TouchEvent) => {
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
      cancelledRef.current = true;
      activeRef.current = false;
      dragOffsetRef.current = 0;
      setDragOffset(0);
      setIsDragging(false);
      return;
    }

    dragOffsetRef.current = dx;
    setDragOffset(dx);
  }, []);

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

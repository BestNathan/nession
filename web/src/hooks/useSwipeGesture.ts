import { useState, useRef, useCallback, type TouchEvent } from 'react';

const SWIPE_THRESHOLD = 50;
const DIRECTION_LOCK_RATIO = 1.5;

export interface SwipeGestureState {
  dragOffset: number;
  isDragging: boolean;
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

export function useSwipeGesture(
  panelCount: number,
  activeIndex: number,
  onIndexChange: (index: number) => void,
): SwipeGestureState {
  const [dragOffset, setDragOffset] = useState(0);
  const dragOffsetRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const lockedRef = useRef<'horizontal' | 'vertical' | null>(null);

  const resetState = useCallback(() => {
    setIsDragging(false);
    isDraggingRef.current = false;
    setDragOffset(0);
    dragOffsetRef.current = 0;
    lockedRef.current = null;
  }, []);

  const onTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    lockedRef.current = null;
    setIsDragging(true);
    isDraggingRef.current = true;
    setDragOffset(0);
    dragOffsetRef.current = 0;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!isDraggingRef.current) { return; }
    const touch = e.touches[0];
    const deltaX = touch.clientX - startXRef.current;
    const deltaY = touch.clientY - startYRef.current;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (lockedRef.current === null) {
      if (absX > 10 || absY > 10) {
        lockedRef.current = absX > absY * DIRECTION_LOCK_RATIO ? 'horizontal' : 'vertical';
      }
      return;
    }
    if (lockedRef.current === 'horizontal') {
      e.preventDefault();
      dragOffsetRef.current = deltaX;
      setDragOffset(deltaX);
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!isDraggingRef.current) { return; }
    const absDelta = Math.abs(dragOffsetRef.current);
    if (absDelta > SWIPE_THRESHOLD) {
      const direction = dragOffsetRef.current > 0 ? -1 : 1;
      const newIndex = Math.max(0, Math.min(panelCount - 1, activeIndex + direction));
      if (newIndex !== activeIndex) { onIndexChange(newIndex); }
    }
    resetState();
  }, [panelCount, activeIndex, onIndexChange, resetState]);

  const onTouchCancel = useCallback(() => { resetState(); }, [resetState]);

  return { dragOffset, isDragging, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
}

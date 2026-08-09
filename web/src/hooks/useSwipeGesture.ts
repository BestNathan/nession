import { useState, useRef, useCallback, type TouchEvent } from 'react';

const SWIPE_THRESHOLD = 50;
const DIRECTION_LOCK_RATIO = 1.5;
const LOCK_DEAD_ZONE = 10;

/**
 * Walk up the DOM from `el` to find the nearest ancestor element that has
 * horizontal overflow (can be scrolled left/right by the browser).
 * Returns null if no scrollable ancestor exists.
 */
function findHorizontallyScrollableAncestor(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowX = style.overflowX;
    // Only elements with overflow-x: auto or scroll can scroll horizontally
    if (overflowX === 'auto' || overflowX === 'scroll') {
      // Verify there's actually overflow content (scrollWidth > clientWidth)
      if (current.scrollWidth > current.clientWidth + 1) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Check whether a horizontally-scrollable element can still scroll in the
 * direction indicated by `deltaX` (finger movement).
 *
 * deltaX > 0 → finger moved right → content can scrollLeft (content is offset right)
 * deltaX < 0 → finger moved left  → content can scrollRight (more content to the right)
 */
function canScrollInDirection(el: HTMLElement, deltaX: number): boolean {
  if (deltaX > 0) {
    return el.scrollLeft > 1;
  }
  return el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
}

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
  const lockedRef = useRef<'horizontal' | 'vertical' | 'child-scroll' | null>(null);

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

    // Direction lock: wait until the finger has moved enough to determine intent.
    if (lockedRef.current === null) {
      if (absX > LOCK_DEAD_ZONE || absY > LOCK_DEAD_ZONE) {
        if (absX > absY * DIRECTION_LOCK_RATIO) {
          // Candidate horizontal swipe → check whether a scrollable child
          // (e.g. CodeMirror viewer) wants this gesture for its own scroll.
          const target = e.target as HTMLElement;
          const scrollable = findHorizontallyScrollableAncestor(target);
          if (scrollable && canScrollInDirection(scrollable, deltaX)) {
            // Child can still scroll — abandon the panel-swipe gesture so
            // the browser handles the child's native horizontal scroll.
            lockedRef.current = 'child-scroll';
            setIsDragging(false);
            isDraggingRef.current = false;
            return;
          }
          lockedRef.current = 'horizontal';
        } else {
          lockedRef.current = 'vertical';
        }
      }
      return;
    }

    if (lockedRef.current === 'child-scroll') { return; }

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

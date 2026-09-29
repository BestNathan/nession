import { useCallback, useEffect, useRef, useState } from 'react';
import throttle from 'lodash.throttle';

/** Default collapsed record block height — tuned for multi-record viewport density. */
export const JSONL_COLLAPSED_ESTIMATE_PX = 168;
export const JSONL_EXPANDED_ESTIMATE_PX = 360;
const OVERSCAN = 4;

export interface JsonlVirtualWindow {
  startIndex: number;
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
  onScroll: () => void;
  setRowHeight: (lineNumber: number, height: number) => void;
  scrollRef: (node: HTMLDivElement | null) => void;
}

/**
 * Viewport-driven JSONL record window — mounts rich previews only near the scroll
 * position instead of the full record set (#1199).
 */
export function useJsonlVirtualWindow(
  recordCount: number,
  getLineNumber: (index: number) => number,
  expandedLines: ReadonlySet<number>,
): JsonlVirtualWindow {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Map<number, number>>(new Map());
  const [range, setRange] = useState({ start: 0, end: Math.min(recordCount, 24) });

  const estimateHeight = useCallback(
    (index: number) => {
      const lineNumber = getLineNumber(index);
      const measured = heightsRef.current.get(lineNumber);
      if (measured !== undefined) {
        return measured;
      }
      return expandedLines.has(lineNumber) ? JSONL_EXPANDED_ESTIMATE_PX : JSONL_COLLAPSED_ESTIMATE_PX;
    },
    [expandedLines, getLineNumber],
  );

  const recompute = useCallback(() => {
    const el = containerRef.current;
    if (!el || recordCount === 0) {
      setRange({ start: 0, end: 0 });
      return;
    }
    const scrollTop = el.scrollTop;
    const viewHeight = el.clientHeight;
    let offset = 0;
    let start = 0;
    while (start < recordCount && offset + estimateHeight(start) < scrollTop) {
      offset += estimateHeight(start);
      start += 1;
    }
    let end = start;
    let visible = 0;
    while (end < recordCount && visible < viewHeight + JSONL_COLLAPSED_ESTIMATE_PX) {
      visible += estimateHeight(end);
      end += 1;
    }
    start = Math.max(0, start - OVERSCAN);
    end = Math.min(recordCount, end + OVERSCAN);
    setRange({ start, end });
  }, [estimateHeight, recordCount]);

  useEffect(() => {
    recompute();
  }, [recompute, expandedLines, recordCount]);

  const throttledRecompute = useRef(throttle(recompute, 32)).current;

  useEffect(() => {
    return () => {
      throttledRecompute.cancel();
    };
  }, [throttledRecompute]);

  const onScroll = useCallback(() => {
    throttledRecompute();
  }, [throttledRecompute]);

  const setRowHeight = useCallback(
    (lineNumber: number, height: number) => {
      const prev = heightsRef.current.get(lineNumber);
      if (prev !== undefined && Math.abs(prev - height) < 2) {
        return;
      }
      heightsRef.current.set(lineNumber, height);
      throttledRecompute();
    },
    [throttledRecompute],
  );

  let paddingTop = 0;
  for (let i = 0; i < range.start; i++) {
    paddingTop += estimateHeight(i);
  }
  let total = paddingTop;
  for (let i = range.start; i < range.end; i++) {
    total += estimateHeight(i);
  }
  let full = total;
  for (let i = range.end; i < recordCount; i++) {
    full += estimateHeight(i);
  }
  const paddingBottom = Math.max(0, full - total);

  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) {
      recompute();
    }
  }, [recompute]);

  return {
    startIndex: range.start,
    endIndex: range.end,
    paddingTop,
    paddingBottom,
    onScroll,
    setRowHeight,
    scrollRef,
  };
}

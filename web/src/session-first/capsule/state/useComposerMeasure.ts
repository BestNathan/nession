import { useLayoutEffect, useRef } from 'react';
import { measureLineCount } from '@/session-first/capsule/measure/measureLineCount';
import { readComposerMetricsFromField } from '@/session-first/capsule/measure/readComposerMetrics';

interface UseComposerMeasureOptions {
  value: string;
  shellRef: React.RefObject<HTMLElement | null>;
  contentWidthRef: React.RefObject<HTMLElement | null>;
  onLineCountChange: (lineCount: number) => void;
  enabled?: boolean;
}

/**
 * Mirror textarea at full shell content width so line count does not depend
 * on flat vs stacked render width.
 */
export function useComposerMeasure({
  value,
  shellRef,
  contentWidthRef,
  onLineCountChange,
  enabled = true,
}: UseComposerMeasureOptions): React.Ref<HTMLTextAreaElement> {
  const mirrorRef = useRef<HTMLTextAreaElement>(null);
  const onLineCountChangeRef = useRef(onLineCountChange);
  onLineCountChangeRef.current = onLineCountChange;

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const mirror = mirrorRef.current;
    const shell = shellRef.current;
    const widthEl = contentWidthRef.current ?? shell;
    if (!mirror || !shell || !widthEl) {
      return;
    }

    mirror.style.width = `${widthEl.clientWidth}px`;
    mirror.value = value;

    const prevHeight = mirror.style.height;
    mirror.style.height = 'auto';
    const measured = mirror.scrollHeight;
    mirror.style.height = prevHeight;

    const metrics = readComposerMetricsFromField(shell, mirror);
    const lines = measureLineCount(value, measured, metrics);
    onLineCountChangeRef.current(lines);
  }, [contentWidthRef, enabled, shellRef, value]);

  return mirrorRef;
}

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { observeElementRect as defaultObserveElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { parseJsonlRecords, type JsonlRecord } from '../model/jsonParse';
import { JsonlRecord as JsonlRecordRow } from './JsonlRecord';
import { readScrollportHeight, syncJsonlScrollportHeight } from './jsonlScrollport';

/** Bootstrap only — real height comes from measureElement + ResizeObserver (#1199 review). */
const ESTIMATE_BEFORE_MEASURE_PX = 96;
const VIRTUAL_OVERSCAN = 6;

interface JsonlPreviewProps {
  content: string;
}

export function JsonlPreview({ content }: JsonlPreviewProps) {
  const records = useMemo(() => parseJsonlRecords(content), [content]);
  const parentRef = useRef<HTMLDivElement>(null);
  const [scrollportReady, setScrollportReady] = useState(false);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(() => new Set());

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) {
      return;
    }
    const syncScrollportHeight = () => {
      syncJsonlScrollportHeight(el);
      setScrollportReady(readScrollportHeight(el) > 0);
    };
    syncScrollportHeight();
    const parent = el.parentElement;
    if (!parent) {
      return;
    }
    const observer = new ResizeObserver(syncScrollportHeight);
    observer.observe(parent);
    observer.observe(el);
    return () => observer.disconnect();
  }, [records.length]);

  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATE_BEFORE_MEASURE_PX,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => records[index]?.lineNumber ?? index,
    enabled: scrollportReady,
    observeElementRect: (instance, cb) =>
      defaultObserveElementRect(instance, (rect) => {
        const el = instance.scrollElement;
        const height = el ? readScrollportHeight(el) : rect.height;
        cb(height > 0 ? { ...rect, height } : rect);
      }),
  });

  const toggleLine = useCallback((lineNumber: number) => {
    setExpandedLines((prev) => {
      const next = new Set(prev);
      if (next.has(lineNumber)) {
        next.delete(lineNumber);
      } else {
        next.add(lineNumber);
      }
      return next;
    });
  }, []);

  if (records.length === 0) {
    return (
      <div className="p-[var(--workspace-editor-pad-y)] px-[var(--workspace-editor-head-pad-x)] text-sm text-muted-foreground">
        No JSONL records in this file.
      </div>
    );
  }

  const virtualItems = scrollportReady ? virtualizer.getVirtualItems() : [];

  return (
    <div ref={parentRef} data-testid="jsonl-preview-scroll" className="overflow-y-auto h-full min-w-0">
      <div
        style={{
          height: scrollportReady ? `${virtualizer.getTotalSize()}px` : undefined,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const record: JsonlRecord = records[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <JsonlRecordRow
                record={record}
                expanded={expandedLines.has(record.lineNumber)}
                onToggleExpanded={() => toggleLine(record.lineNumber)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

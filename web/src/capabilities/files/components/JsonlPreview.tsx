import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseJsonlRecords, type JsonlRecord } from '../model/jsonParse';
import { JsonlRecord as JsonlRecordRow } from './JsonlRecord';

/** Line label + padded section + capped compact body (measured after mount). */
const ESTIMATED_COLLAPSED_PX = 176;
const ESTIMATED_EXPANDED_PX = 360;
const VIRTUAL_OVERSCAN = 6;
/** Below this count, a plain list avoids virtual overlap glitches in tight viewports. */
const VIRTUALIZE_MIN_RECORDS = 48;

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
    const sync = () => {
      setScrollportReady(el.clientHeight > 0);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [records.length]);

  const estimateSize = useCallback(
    (index: number) => (expandedLines.has(records[index]?.lineNumber ?? -1) ? ESTIMATED_EXPANDED_PX : ESTIMATED_COLLAPSED_PX),
    [expandedLines, records],
  );

  const shouldVirtualize = scrollportReady && records.length >= VIRTUALIZE_MIN_RECORDS;

  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => records[index]?.lineNumber ?? index,
    enabled: shouldVirtualize,
  });

  useLayoutEffect(() => {
    if (shouldVirtualize) {
      virtualizer.measure();
    }
  }, [expandedLines, records, shouldVirtualize, virtualizer]);

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

  const renderRecord = (record: JsonlRecord) => (
    <JsonlRecordRow
      record={record}
      expanded={expandedLines.has(record.lineNumber)}
      onToggleExpanded={() => toggleLine(record.lineNumber)}
    />
  );

  if (!shouldVirtualize) {
    return (
      <div ref={parentRef} className="overflow-y-auto h-full min-w-0">
        {records.map((record) => (
          <div key={record.lineNumber}>{renderRecord(record)}</div>
        ))}
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} className="overflow-y-auto h-full min-w-0 overscroll-contain">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
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
              className="left-0 top-0 w-full overflow-hidden isolate"
              style={{
                position: 'absolute',
                transform: `translate3d(0, ${virtualRow.start}px, 0)`,
              }}
            >
              {renderRecord(record)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

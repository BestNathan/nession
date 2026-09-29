import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseJsonlRecords, type JsonlRecord } from '../model/jsonParse';
import { JsonlRecord as JsonlRecordRow } from './JsonlRecord';

const ESTIMATED_COLLAPSED_PX = 120;
const ESTIMATED_EXPANDED_PX = 280;
const VIRTUAL_OVERSCAN = 8;

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

  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => records[index]?.lineNumber ?? index,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [expandedLines, virtualizer]);

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

  const renderRecord = (record: JsonlRecord) => (
    <JsonlRecordRow
      key={record.lineNumber}
      record={record}
      expanded={expandedLines.has(record.lineNumber)}
      onToggleExpanded={() => toggleLine(record.lineNumber)}
    />
  );

  if (records.length === 0) {
    return (
      <div className="p-[var(--workspace-editor-pad-y)] px-[var(--workspace-editor-head-pad-x)] text-sm text-muted-foreground">
        No JSONL records in this file.
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const useVirtualList = scrollportReady && virtualItems.length > 0;

  return (
    <div ref={parentRef} className="overflow-y-auto h-full min-w-0">
      {useVirtualList ? (
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
                key={record.lineNumber}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {renderRecord(record)}
              </div>
            );
          })}
        </div>
      ) : (
        records.map((record) => renderRecord(record))
      )}
    </div>
  );
}

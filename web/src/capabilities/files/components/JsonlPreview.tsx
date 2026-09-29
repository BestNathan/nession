import { useCallback, useMemo, useState } from 'react';
import { parseJsonlRecords, type JsonlRecord } from '../model/jsonParse';
import { useJsonlVirtualWindow } from '../hooks/useJsonlVirtualWindow';
import { JsonRecordPreview } from './JsonRecordPreview';

interface JsonlPreviewProps {
  content: string;
}

export function JsonlPreview({ content }: JsonlPreviewProps) {
  const records = useMemo(() => parseJsonlRecords(content), [content]);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(() => new Set());

  const getLineNumber = useCallback(
    (index: number) => records[index]?.lineNumber ?? index + 1,
    [records],
  );

  const {
    startIndex,
    endIndex,
    paddingTop,
    paddingBottom,
    onScroll,
    setRowHeight,
    scrollRef,
  } = useJsonlVirtualWindow(records.length, getLineNumber, expandedLines);

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

  const visible = records.slice(startIndex, endIndex);

  if (records.length === 0) {
    return (
      <div className="p-[var(--workspace-editor-pad-y)] px-[var(--workspace-editor-head-pad-x)] text-sm text-muted-foreground">
        No JSONL records in this file.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="overflow-y-auto h-full min-w-0"
      onScroll={onScroll}
    >
      <div style={{ paddingTop, paddingBottom }} className="min-w-0">
        {visible.map((record: JsonlRecord) => (
          <JsonRecordPreview
            key={record.lineNumber}
            record={record}
            expanded={expandedLines.has(record.lineNumber)}
            onToggleExpanded={() => toggleLine(record.lineNumber)}
            onHeightChange={setRowHeight}
          />
        ))}
      </div>
    </div>
  );
}

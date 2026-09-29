import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { JsonlRecord } from '../model/jsonParse';
import { JsonValuePreview } from './JsonValuePreview';

/** Bounded compact height for collapsed JSONL records (multi-record viewport). */
const COMPACT_MAX_PX = 168;

interface JsonRecordPreviewProps {
  record: JsonlRecord;
  expanded: boolean;
  onToggleExpanded: () => void;
  onHeightChange: (lineNumber: number, height: number) => void;
}

export function JsonRecordPreview({
  record,
  expanded,
  onToggleExpanded,
  onHeightChange,
}: JsonRecordPreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [needsExpand, setNeedsExpand] = useState(false);
  const disclosureId = useId();
  const lineLabel = `Line ${record.lineNumber}`;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) {
      return;
    }
    setNeedsExpand(el.scrollHeight > COMPACT_MAX_PX + 4);
  }, [record, expanded]);

  useEffect(() => {
    const el = bodyRef.current?.closest('[data-jsonl-row]') as HTMLElement | null;
    if (!el) {
      return;
    }
    const report = () => onHeightChange(record.lineNumber, el.getBoundingClientRect().height);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, needsExpand, onHeightChange, record.lineNumber]);

  const showDisclosure = expanded || needsExpand;

  return (
    <article
      data-jsonl-row
      className="border-b border-border/50 py-[var(--shell-space-2)]"
      aria-labelledby={disclosureId}
    >
      <div className="flex items-center gap-2 mb-1 px-[var(--workspace-editor-head-pad-x)]">
        <span id={disclosureId} className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
          {lineLabel}
        </span>
        {showDisclosure ? (
          <button
            type="button"
            className={cn(
              'ml-auto inline-flex items-center gap-1 text-[length:var(--workspace-editor-action-font-size)] text-muted-foreground hover:text-foreground',
            )}
            aria-expanded={expanded}
            onClick={() => onToggleExpanded()}
          >
            {expanded ? 'Collapse' : 'Expand'}
            <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
          </button>
        ) : null}
      </div>
      <div className="px-[var(--workspace-editor-head-pad-x)] min-w-0">
        {record.kind === 'invalid' ? (
          <div role="alert" className="text-sm">
            <p className="text-destructive font-medium">Invalid JSON</p>
            <p className="text-muted-foreground font-mono text-[length:var(--workspace-editor-font-size)] mt-1">
              {record.message}
            </p>
            <pre className="mt-2 font-mono text-[length:var(--workspace-editor-font-size)] whitespace-pre-wrap break-all text-foreground/80">
              {record.raw}
            </pre>
          </div>
        ) : (
          <div
            ref={bodyRef}
            className={cn(
              'relative min-w-0',
              !expanded && needsExpand && 'max-h-[168px] overflow-hidden',
            )}
          >
            <JsonValuePreview value={record.value} />
            {!expanded && needsExpand ? (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent"
                aria-hidden
              />
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}

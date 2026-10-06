import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { JsonTree } from '@/components/json/JsonTree';
import { jsonlRecordBodyClass, jsonPreviewSurfaceClass } from '@/components/json/jsonTreeSyntax';
import type { JsonlRecord as JsonlRecordModel } from '../model/jsonParse';
import { chromeMonoLabelRole, chromeSansRole } from '@/shared/typography/chromeRoles';

interface JsonlRecordProps {
  record: JsonlRecordModel;
  expanded: boolean;
  onToggleExpanded: () => void;
}

export function JsonlRecord({
  record,
  expanded,
  onToggleExpanded,
}: JsonlRecordProps) {
  const lineLabelId = useId();
  const lineLabel = `Line ${record.lineNumber}`;

  return (
    <section
      data-jsonl-line={record.lineNumber}
      className="border-b border-border/50 py-[var(--nession-shell-space-2)] px-[var(--nession-workspace-editor-head-pad-x)] min-w-0"
      aria-labelledby={lineLabelId}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          id={lineLabelId}
          className={cn('text-muted-foreground', chromeMonoLabelRole('caption'))}
        >
          {lineLabel}
        </span>
        {record.kind === 'valid' ? (
          <button
            type="button"
            className={cn(
              'ml-auto inline-flex items-center gap-1 text-[length:var(--nession-workspace-editor-action-font-size)] text-muted-foreground hover:text-foreground',
            )}
            aria-expanded={expanded}
            onClick={() => onToggleExpanded()}
          >
            {expanded ? 'Collapse record' : 'Expand record'}
            <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
          </button>
        ) : null}
      </div>
      {record.kind === 'invalid' ? (
        <div role="alert" className={cn('min-w-0', chromeSansRole('secondary'), jsonPreviewSurfaceClass('border-destructive/30 bg-destructive/5'))}>
          <p className={cn('text-destructive', chromeSansRole('secondary'))}>Invalid JSON</p>
          <p className="text-muted-foreground font-mono text-[length:var(--nession-workspace-editor-font-size)] mt-1">
            {record.message}
          </p>
          <pre className="mt-2 font-mono text-[length:var(--nession-workspace-editor-font-size)] whitespace-pre-wrap break-all text-foreground/80">
            {record.raw}
          </pre>
        </div>
      ) : (
        <div className={jsonlRecordBodyClass(expanded)}>
          <JsonTree value={record.value} mode={expanded ? 'inspector' : 'compact'} pinRootOpen={expanded} />
        </div>
      )}
    </section>
  );
}

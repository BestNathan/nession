import { Button } from '@/components/ui/button';
import { DetailEmpty, DetailNote, DetailSection } from '@/components/ui/resource-detail';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';

import type { McpCallRecord } from '../types';

const STATUS_COPY: Record<McpCallRecord['status'], string> = {
  success: 'Completed',
  isError: 'Tool returned an error',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
  failed: 'Failed',
  confirmation_required: 'Awaiting confirmation',
};

/** Bounded, in-memory call history. Nothing here is persisted. */
export function McpCallHistory({
  history,
  onSelect,
}: {
  history: readonly McpCallRecord[];
  onSelect: (record: McpCallRecord) => void;
}) {
  return (
    <DetailSection
      title="Recent calls"
      testId="mcp-call-history"
      action={
        <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          In-memory · up to 5
        </span>
      }
    >
      {history.length === 0 ? (
        <DetailEmpty data-testid="mcp-call-history-empty">No calls yet.</DetailEmpty>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {history.map((record) => (
            <li key={record.id} className="min-w-0">
              <Button
                type="button"
                variant="ghost"
                data-testid="mcp-call-history-row"
                data-call-status={record.status}
                disabled={!record.result}
                onClick={() => onSelect(record)}
                className="h-auto w-full min-w-0 flex-col items-start gap-0.5 py-1.5 text-left"
              >
                <span className={cn('min-w-0 break-all', chromeMonoRole('code'))}>
                  {record.tool}
                </span>
                <span className={cn('text-muted-foreground', chromeSansRole('caption'))}>
                  {STATUS_COPY[record.status]} · {record.at}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <DetailNote>
        A call appears only after an explicit Run. Selecting a Tool never adds one.
      </DetailNote>
    </DetailSection>
  );
}

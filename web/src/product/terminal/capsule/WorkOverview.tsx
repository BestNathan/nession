/**
 * Work Overview — modal showing active work summaries (#1347 SC-18, SC-19).
 *
 * When the user clicks `+` while working, this modal displays summaries from
 * all capabilities that are currently working. It uses structured plugin data
 * (WorkSummary) and Nession-owned rendering — plugins provide the data, Nession
 * decides how it looks.
 *
 * **Design Decisions:**
 * - Uses Dialog (shadcn) for modal behavior
 * - Lists all working capabilities with their summaries
 * - Selecting a capability opens its Peek (SC-20)
 * - Header and workspace destination are Nession-owned (SC-21)
 * - Plugin-contributed UI lives in a constrained scroll viewport (SC-22)
 *
 * **Success Criteria:**
 * - SC-18: + opens Work Overview rather than installed-plugin catalog
 * - SC-19: Work Overview uses structured plugin data and Nession-owned rendering
 * - SC-20: Selecting a capability opens Capability Peek
 * - SC-21: Peek header and Workspace destination are Nession-owned
 * - SC-22: Peek body may be plugin-contributed rich UI inside constrained scroll viewport
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { capsuleCaptionTextClass } from '@/product/terminal/capsule/capsuleStyles';
import type { ResolvedWorkContext, WorkSummary } from '@/product/terminal/capsule/workAwareness';
import type { CapabilityId } from '@/product/capability';
import { cn } from '@/shared/lib/utils';

interface WorkOverviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workContext: ResolvedWorkContext;
  onSelectCapability?: (capabilityId: CapabilityId) => void;
}

/**
 * Work Overview modal — shows active work summaries.
 *
 * When working, clicking `+` opens this modal instead of the capability
 * disclosure menu. It lists all capabilities that are currently working, with
 * their human-readable summaries. Selecting a capability opens its Peek.
 */
export function WorkOverview({
  open,
  onOpenChange,
  workContext,
  onSelectCapability,
}: WorkOverviewProps) {
  const workingSummaries = workContext.summaries.filter(
    (summary) => summary.status === 'working',
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Active Work</DialogTitle>
        </DialogHeader>
        <ScrollArea>
          {workingSummaries.length === 0 ? (
            <div
              className={cn(
                'py-[length:var(--shell-space-4)] text-center text-muted-foreground',
                capsuleCaptionTextClass,
              )}
            >
              No active work
            </div>
          ) : (
            <div className="space-y-[length:var(--shell-space-1)]">
              {workingSummaries.map((summary) => (
                <WorkSummaryItem
                  key={summary.capabilityId}
                  summary={summary}
                  onSelect={() => {
                    onSelectCapability?.(summary.capabilityId);
                    onOpenChange(false);
                  }}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

interface WorkSummaryItemProps {
  summary: WorkSummary;
  onSelect: () => void;
}

/**
 * Individual work summary item — clickable to open capability Peek.
 *
 * Displays the capability ID and summary text. Clicking opens the capability's
 * Peek surface (SC-20). The item uses Nession-owned styling — plugins cannot
 * alter the visual presentation (SC-21, SC-24).
 */
function WorkSummaryItem({ summary, onSelect }: WorkSummaryItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col items-start gap-[length:var(--shell-space-0)] rounded-[length:var(--radius-control)]',
        'border border-border bg-background p-[length:var(--shell-space-1)]',
        'text-left transition-colors hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      data-testid={`work-summary-${summary.capabilityId}`}
    >
      <div className={cn('font-medium capitalize', capsuleCaptionTextClass)}>
        {summary.capabilityId}
      </div>
      <div className={cn('text-muted-foreground', capsuleCaptionTextClass)}>
        {summary.summary}
      </div>
    </button>
  );
}

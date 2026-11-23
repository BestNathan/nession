import { ChevronRight, FileText, MessagesSquare, Plug, ScrollText, Settings } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { WorkspaceBoundedScrollport } from '@/components/ui/workspace-scrollport';
import type { AppRoute } from './model';

/**
 * A bounded scroll owner inside the Workspace (#4222 SC-01).
 *
 * `className` is content spacing and is applied inside the scroll viewport, so
 * a route's `p-2`/`pb-6` can never override the host-measured bottom inset.
 */
export function ScrollBody({
  children,
  className,
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  /** Stable endpoint marker for the route coverage contract (#4222 SC-03). */
  testId?: string;
}) {
  return (
    <WorkspaceBoundedScrollport className={className} data-testid={testId}>
      {children}
    </WorkspaceBoundedScrollport>
  );
}

/** The compact page intro every pushed resource depth opens with. */
export function ResourceIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="shrink-0 border-b px-4 pb-3 pt-4">
      <p className={chromeLabelRole()}>{eyebrow}</p>
      <h2 className={cn('mt-1 wrap-anywhere', chromeSansRole('title'))}>{title}</h2>
      {description ? (
        <p className={cn('mt-1 text-muted-foreground', chromeSansRole('secondary'))}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

function BrowseRow({
  icon,
  label,
  description,
  testId,
  onSelect,
}: {
  icon: typeof FileText;
  label: string;
  description: string;
  testId: string;
  onSelect: () => void;
}) {
  const Glyph = icon;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => onSelect()}
      className={cn(
        'flex min-h-11 w-full items-center gap-3 rounded-[var(--nession-radius-control)] px-2 py-2 text-left transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-[var(--nession-radius-control)] bg-muted text-muted-foreground">
        <Glyph className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('truncate', chromeSansRole('primary'))}>{label}</span>
        <span className={cn('truncate text-muted-foreground', chromeSansRole('caption'))}>
          {description}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

/**
 * The App's one contextual resource index.
 *
 * It is a sheet rather than a page or a tab strip: choosing a resource is a
 * temporary act from the work, and the work stays underneath. Picking an entry
 * replaces the pushed stack with that resource's root, so Back always returns
 * to the conversation.
 */
export function BrowseSheet({
  open,
  onOpenChange,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (route: AppRoute) => void;
}) {
  const choose = (route: AppRoute) => {
    onOpenChange(false);
    onChoose(route);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="sheet"
        data-experience="app"
        data-testid="claude-browse-sheet"
      >
        <DialogHeader>
          <DialogTitle>Browse Claude</DialogTitle>
          <DialogDescription>
            The conversation is the work. These are the resources behind it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-1 pb-[max(var(--nession-shell-space-3),env(safe-area-inset-bottom))]">
          <p className={cn('px-2 pt-1', chromeLabelRole())}>Work</p>
          <BrowseRow
            icon={MessagesSquare}
            label="Conversations"
            description="Current and recent history"
            testId="claude-browse-conversations"
            onSelect={() => choose({ kind: 'conversations' })}
          />
          <BrowseRow
            icon={ScrollText}
            label="Transcripts"
            description="Every recorded event, with Raw"
            testId="claude-browse-transcripts"
            onSelect={() => choose({ kind: 'transcripts' })}
          />
          <p className={cn('px-2 pt-4', chromeLabelRole())}>Resources &amp; setup</p>
          <BrowseRow
            icon={FileText}
            label="Memory"
            description="This project's memory files"
            testId="claude-browse-memory"
            onSelect={() => choose({ kind: 'memory' })}
          />
          <BrowseRow
            icon={Plug}
            label="MCP"
            description="Connections and tool schemas"
            testId="claude-browse-mcp"
            onSelect={() => choose({ kind: 'mcp' })}
          />
          <BrowseRow
            icon={Settings}
            label="Configuration"
            description="Project and Global settings"
            testId="claude-browse-configuration"
            onSelect={() => choose({ kind: 'configuration' })}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

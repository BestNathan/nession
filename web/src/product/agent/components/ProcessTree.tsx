import { Badge } from '@/components/ui/badge';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { DiscoveredProcess, PaneProcessSnapshot } from '@/product/agent/types';
import {
  buildProcessTree,
  coverageLabel,
  displayCommand,
  paneTitle,
  isSet,
  processKey,
  reasonLabel,
  type ProcessTreeNode,
} from '@/product/agent/model/processSnapshot';

export interface SelectedProcess {
  paneId: string;
  process: DiscoveredProcess;
}

export interface ProcessTreeProps {
  panes: PaneProcessSnapshot[];
  selected: SelectedProcess | null;
  onSelect: (selection: SelectedProcess) => void;
}

function coverageVariant(coverage: PaneProcessSnapshot['coverage']): 'secondary' | 'outline' | 'destructive' {
  switch (coverage) {
    case 'complete':
      return 'secondary';
    case 'partial':
      return 'outline';
    default:
      return 'destructive';
  }
}

/**
 * Session → Pane → process tree.
 *
 * Panes are grouped from the snapshot's linked-window rows, so a Window linked
 * into several Sessions is one Pane here and its processes appear once.
 */
export function ProcessTree({ panes, selected, onSelect }: ProcessTreeProps) {
  if (panes.length === 0) {
    return (
      <p className={cn('text-muted-foreground', chromeSansRole('body'))}>
        No Panes were reported for this Session.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {panes.map((pane) => (
        <PaneSection
          key={pane.pane_id}
          pane={pane}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function PaneSection({
  pane,
  selected,
  onSelect,
}: {
  pane: PaneProcessSnapshot;
  selected: SelectedProcess | null;
  onSelect: (selection: SelectedProcess) => void;
}) {
  const tree = buildProcessTree(pane.processes);
  return (
    <section
      data-testid={`process-pane-${pane.pane_id}`}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className={cn('min-w-0 truncate', chromeSansRole('primary'))}>{paneTitle(pane)}</h4>
        <Badge variant={coverageVariant(pane.coverage)}>{coverageLabel(pane.coverage)}</Badge>
        <span className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>
          {pane.pane_id}
        </span>
        {isSet(pane.pane_pid) ? (
          <span className={cn('text-muted-foreground', chromeMonoRole('metadata'))}>
            PID {pane.pane_pid}
          </span>
        ) : null}
      </div>
      {pane.session_names.length > 1 ? (
        <p className={cn('text-muted-foreground', chromeSansRole('caption'))}>
          Linked into {pane.session_names.join(', ')} — listed once.
        </p>
      ) : null}
      {pane.reason_codes.length > 0 ? (
        <p
          data-testid={`process-pane-reasons-${pane.pane_id}`}
          className={cn('text-muted-foreground', chromeSansRole('caption'))}
        >
          {pane.reason_codes.map(reasonLabel).join(' ')}
        </p>
      ) : null}

      {tree.length === 0 ? (
        <p className={cn('text-muted-foreground', chromeSansRole('body'))}>
          No processes were observed for this Pane.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5" data-testid={`process-tree-${pane.pane_id}`}>
          {tree.map((node) => (
            <TreeItem
              key={`${pane.pane_id}:${processKey(node.process)}`}
              paneId={pane.pane_id}
              node={node}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TreeItem({
  paneId,
  node,
  selected,
  onSelect,
}: {
  paneId: string;
  node: ProcessTreeNode;
  selected: SelectedProcess | null;
  onSelect: (selection: SelectedProcess) => void;
}) {
  const isSelected =
    selected?.paneId === paneId && processKey(selected.process) === processKey(node.process);
  const command = displayCommand(node.process);
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-pressed={isSelected}
        onClick={() => onSelect({ paneId, process: node.process })}
        className={cn(
          'flex min-h-9 w-full min-w-0 items-center gap-2 rounded-[var(--nession-radius-control)] px-2 text-left transition-colors',
          isSelected ? 'bg-muted' : 'hover:bg-muted/60',
        )}
      >
        <span
          className={cn('min-w-0 flex-1 truncate', chromeMonoRole('code'))}
          title={command}
        >
          {command}
        </span>
        {node.process.command_state !== 'sampled' ? (
          <Badge variant="outline">command unavailable</Badge>
        ) : null}
        {node.process.redacted ? <Badge variant="outline">redacted</Badge> : null}
        <span className={cn('shrink-0 text-muted-foreground', chromeMonoRole('metadata'))}>
          {node.process.pid}
        </span>
      </button>
      {node.children.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pl-4">
          {node.children.map((child) => (
            <TreeItem
              key={`${paneId}:${processKey(child.process)}`}
              paneId={paneId}
              node={child}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

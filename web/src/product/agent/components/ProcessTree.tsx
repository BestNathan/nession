import { Badge } from '@/components/ui/badge';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import type { DiscoveredProcess } from '@/product/agent/types';
import {
  buildProcessTree,
  displayCommand,
  processKey,
  type ProcessTreeNode,
} from '@/product/agent/model/processSnapshot';

export interface ProcessTreeProps {
  /** The current Session's processes, already deduplicated by identity. */
  processes: DiscoveredProcess[];
  selected: DiscoveredProcess | null;
  onSelect: (process: DiscoveredProcess) => void;
}

/**
 * One process forest for the current Session.
 *
 * Pane/Window identity never appears here: it is discovery evidence, not a
 * product noun. Only real PPID edges are drawn, so a process whose parent is
 * not observed is its own root.
 */
export function ProcessTree({ processes, selected, onSelect }: ProcessTreeProps) {
  const forest = buildProcessTree(processes);

  if (forest.length === 0) {
    return (
      <p
        data-testid="process-forest-empty"
        className={cn('text-muted-foreground', chromeSansRole('body'))}
      >
        No processes were observed in the current Session.
      </p>
    );
  }

  return (
    <ul data-testid="process-forest" className="flex flex-col gap-0.5">
      {forest.map((node) => (
        <TreeItem
          key={processKey(node.process)}
          node={node}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  selected,
  onSelect,
}: {
  node: ProcessTreeNode;
  selected: DiscoveredProcess | null;
  onSelect: (process: DiscoveredProcess) => void;
}) {
  const isSelected =
    selected !== null && processKey(selected) === processKey(node.process);
  const command = displayCommand(node.process);
  const key = processKey(node.process);
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-pressed={isSelected}
        data-process-key={key}
        onClick={() => onSelect(node.process)}
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
              key={processKey(child.process)}
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

import type { ReactElement } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CapabilityDisclosureEntry, CapabilityId } from '@/product/capability';
import { cn } from '@/lib/utils';

/** A disclosure entry plus the icon this surface happens to have for it. */
export type CapabilityDisclosureMenuEntry = CapabilityDisclosureEntry & { icon?: LucideIcon };

export interface CapabilityDisclosureMenuProps {
  entries: readonly CapabilityDisclosureMenuEntry[];
  onSelect: (id: CapabilityId) => void;
  /**
   * The affordance that opens the list. A surface supplies its own geometry —
   * a Workspace pill and a capsule control do not look alike — while the list
   * itself stays one implementation.
   */
  trigger: ReactElement;
  /** Group heading, e.g. "Workspace capabilities". */
  label: string;
  /** Prefix for per-entry test ids, e.g. `workspace-capability-picker`. */
  testIdPrefix: string;
}

/**
 * The capability list behind one explicit affordance.
 *
 * Two callers, one list: the capsule's `+` and the Workspace's overflow. For the
 * capsule it is now the *only* place capability state appears (#748, revising
 * terminal-capsule.md's `active` row — the resting capsule is identical in every
 * state), so an entry carries its state and the list marks the ones that are
 * relevant or active. A capability that is merely available is listed unmarked.
 *
 * It stays shared so a surface does not have to invent a second list.
 */
export function CapabilityDisclosureMenu({
  entries,
  onSelect,
  trigger,
  label,
  testIdPrefix,
}: CapabilityDisclosureMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent side="top" align="center" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {entries.map((entry) => {
            const Icon = entry.icon;
            // `available` is listed so it stays reachable; only a capability the
            // session actually needs is marked. The marker slot is always
            // present so titles stay aligned whether or not a dot is drawn.
            const perceived = entry.state === 'relevant' || entry.state === 'active';
            return (
              <DropdownMenuItem
                key={entry.id}
                data-testid={`${testIdPrefix}-${entry.id}`}
                data-capability-state={entry.state}
                onClick={() => onSelect(entry.id)}
              >
                <span aria-hidden className="flex w-1.5 shrink-0 justify-center">
                  {perceived ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
                </span>
                {Icon ? <Icon /> : null}
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate',
                    perceived ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {entry.title}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

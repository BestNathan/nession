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
import type { CapabilityId, CapabilityState } from '@/features/capabilities';

/** One capability offered through disclosure. The icon is the caller's presentation. */
export interface CapabilityDisclosureEntry {
  id: CapabilityId;
  title: string;
  icon: LucideIcon;
  state: CapabilityState;
}

export interface CapabilityDisclosureMenuProps {
  entries: readonly CapabilityDisclosureEntry[];
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
 * Progressive disclosure for capabilities that earned no direct presence.
 *
 * The counterpart to a direct slot: a capability that is visible but not
 * relevant belongs here, behind one explicit affordance, rather than in the
 * chrome. It is shared so a new surface does not have to invent a second list.
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
            return (
              <DropdownMenuItem
                key={entry.id}
                data-testid={`${testIdPrefix}-${entry.id}`}
                data-capability-state={entry.state}
                onClick={() => onSelect(entry.id)}
              >
                <Icon />
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

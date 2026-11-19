import {
  ArrowUpRight,
  Check,
  Copy,
  Layers,
  LayoutGrid,
  ListFilter,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type {
  WorkspaceActionIcon,
  WorkspaceHeaderAction,
} from '@/app/workspace/workspaceContext';

/**
 * The App's one semantic icon vocabulary (#3971).
 *
 * A capability names what an action *means* (`refresh`, `copy`, `delete`); the
 * App host resolves the glyph here. Two capabilities offering the same meaning
 * therefore cannot draw two different icons, and a capability cannot smuggle a
 * second visual language into the one header through a ReactNode.
 *
 * The mapping is deliberately small: these are the actions the reference
 * consumers actually contribute. Adding one is a product vocabulary decision,
 * not a local styling choice.
 */
export const APP_ACTION_ICONS: Record<WorkspaceActionIcon, LucideIcon> = {
  browse: LayoutGrid,
  search: Search,
  create: Plus,
  edit: Pencil,
  refresh: RefreshCw,
  filter: ListFilter,
  copy: Copy,
  open: ArrowUpRight,
  confirm: Check,
  delete: Trash2,
  save: Save,
  stack: Layers,
};

/** The most priority icon controls one App header may show. */
export const APP_HEADER_PRIORITY_LIMIT = 2;

/**
 * Split a capability's actions into the two header placements.
 *
 * At most two compact icons; everything else, and every destructive action,
 * goes to More with readable text. A destructive action is never icon-only:
 * the user must be able to read what it deletes before choosing it.
 */
export function partitionHeaderActions(actions: readonly WorkspaceHeaderAction[]): {
  priority: readonly WorkspaceHeaderAction[];
  overflow: readonly WorkspaceHeaderAction[];
} {
  const priority = actions
    .filter((action) => action.priority === true && action.destructive !== true)
    .slice(0, APP_HEADER_PRIORITY_LIMIT);
  const priorityIds = new Set(priority.map((action) => action.id));
  return {
    priority,
    overflow: actions.filter((action) => !priorityIds.has(action.id)),
  };
}

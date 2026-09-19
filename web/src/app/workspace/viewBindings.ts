import { FileCog, FileText, Settings2, UserRound, type LucideIcon } from 'lucide-react';
import { claudeCodeView } from '@/capabilities/claude-code';
import { APP_WORKSPACE_VIEWS } from '../experiences/app/workspaceViews';
import { WEB_WORKSPACE_VIEWS } from '../experiences/web/workspaceViews';
import type { WorkspaceViewBinding, WorkspaceViewId } from './workspaceContext';

/**
 * Which capabilities get a Workspace view, in registration order, and the icon
 * their chrome shows.
 *
 * The icon lives here rather than beside the layouts because an icon is chrome,
 * and chrome belongs to the app layer: both experiences label these four
 * capabilities identically and only draw them differently. The layouts come
 * from the experiences themselves — `experiences/{web,app}/workspaceViews.tsx` —
 * which is where the Web/App difference for a workspace view is now expressed.
 *
 * The order is a deterministic tie-break between equally-present capabilities —
 * it is not priority, and it grants nothing: whether a capability appears, and
 * with what strength, comes from its provider's state and Nession's presence
 * policy (see `capabilities.ts`).
 */
const WORKSPACE_VIEWS: readonly { id: WorkspaceViewId; icon: LucideIcon }[] = [
  { id: 'files', icon: FileText },
  { id: 'session', icon: Settings2 },
  { id: 'agent', icon: UserRound },
  { id: 'env', icon: FileCog },
];

/**
 * Every Workspace view.
 *
 * Two kinds sit here, and the difference is the point. The four above differ
 * per experience, so each experience supplies half of the binding. Claude Code
 * draws the same view in both, so it contributes its binding whole
 * (`capabilities/claude-code/contribution.tsx`) — a capability whose view has
 * no experience difference does not need the app layer to write one for it.
 */
export const WORKSPACE_VIEW_BINDINGS: readonly WorkspaceViewBinding[] = [
  ...WORKSPACE_VIEWS.map(({ id, icon }) => ({
    id,
    icon,
    layout: { web: WEB_WORKSPACE_VIEWS[id], app: APP_WORKSPACE_VIEWS[id] },
  })),
  claudeCodeView,
];

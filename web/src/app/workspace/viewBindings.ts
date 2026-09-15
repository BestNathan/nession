import { agentView } from './views/agentView';
import { claudeCodeView } from './views/claudeCodeView';
import { envView } from './views/envView';
import { filesView } from './views/filesView';
import { sessionView } from './views/sessionView';
import type { WorkspaceViewBinding } from './workspaceContext';

/**
 * Every Workspace view, in the order capabilities register.
 *
 * The order is a deterministic tie-break between equally-present capabilities —
 * it is not priority, and it grants nothing: whether a capability appears, and
 * with what strength, comes from its provider's state and Nession's presence
 * policy (see `capabilities.ts`).
 */
export const WORKSPACE_VIEW_BINDINGS: readonly WorkspaceViewBinding[] = [
  filesView,
  sessionView,
  agentView,
  envView,
  claudeCodeView,
];

import { claudeCodeView } from '@/capabilities/claude-code';
import { agentView } from './views/agentView';
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
 *
 * Claude Code's binding is the one that does not live in `views/`: it is
 * contributed by the capability itself (`capabilities/claude-code/contribution`),
 * which is where a capability's view belongs. The rest still have theirs here
 * and move the same way as Phase 4 continues — this list is where the app says
 * *which* views exist and in what tie-break order, not where each one is written.
 */
export const WORKSPACE_VIEW_BINDINGS: readonly WorkspaceViewBinding[] = [
  filesView,
  sessionView,
  agentView,
  envView,
  claudeCodeView,
];

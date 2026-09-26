/**
 * What the git capability contributes to the shell (#750).
 *
 * The contract types are imported **type-only** on purpose: `CapabilityState`
 * and `WorkspaceViewBinding` belong to surfaces above this layer, and a
 * type-only reference is erased — it creates no runtime edge and no cycle. The
 * layer gate enforces exactly that distinction.
 */
import { GitBranch } from 'lucide-react';
import type { CapabilityState } from '@/product/capability';
import type { WorkspaceViewBinding } from '@/app/workspace/workspaceContext';
import type { CapsuleProjectionBinding } from '@/app/capsuleProjections';
import { GitWorkspace } from './components/GitWorkspace';
import { GitProjection } from './components/GitProjection';

export const GIT_ID = 'git';
export const GIT_TITLE = 'Git';

/**
 * Repository state is **not** an environment fact the shell can probe.
 *
 * Whether a Session sits in a repository is a property of a directory that can
 * change while the Session runs, and answering it costs a round trip to the
 * agent. So the capability declares itself available wherever there is a
 * session to ask about, and the answer — including "there is no repository
 * here" — is the view's to report.
 *
 * That is deliberate against #750 SC4: the four failure states must be readable
 * and must **not** be a disabled capability slot. Presence cannot know them
 * without asking, so it does not guess; it stays `available`, and the view says
 * what is actually wrong. `unavailable` here means only that there is no
 * Session to name.
 */
export function resolveGitState(sessionId: string | undefined): CapabilityState {
  return sessionId ? 'available' : 'unavailable';
}

/**
 * Both experiences render the same view. Git is a repository browser; its
 * Web/App difference is the chrome around it, which the experience compositions
 * own, and the width it has to work with, which the view adapts to itself — not
 * something this binding branches on.
 *
 * The component is named once and used for both keys rather than written out
 * twice as two identical arrow functions: one reference means the two cannot
 * drift apart, and an assertion that they are the same is then a fact about the
 * code rather than a coincidence of two look-alikes.
 *
 * #826 owns the App realization of capability surfaces (push/pop, Signal/Peek).
 * Until that lands this is the shared view at both widths, which is why it
 * stacks rather than assuming a desktop pane.
 */
export const gitView: WorkspaceViewBinding = {
  id: GIT_ID,
  icon: GitBranch,
  layout: { web: GitWorkspace, app: GitWorkspace },
};

/**
 * How Git says something in the Terminal.
 *
 * Declared here rather than in the app layer for the same reason `gitView` is:
 * what Git can say is Git's, and the app layer only decides whether it gets to
 * say it. The binding type is imported **type-only** — it belongs to the app
 * layer's registry, which sits above this one.
 */
export const gitProjection: CapsuleProjectionBinding = {
  id: GIT_ID,
  // A changed-file summary is what sits between "3 changed" and a full diff,
  // so Git has a Peek of its own.
  // A Peek, and that is what earns the entry (#1046).
  entry: 'peek',
  body: ({ agentId, sessionId, depth, onFocusChange, openWorkspace }) => (
    <GitProjection
      agentId={agentId}
      sessionId={sessionId}
      depth={depth}
      onFocusChange={onFocusChange}
      onOpenWorkspace={openWorkspace}
    />
  ),
};

/**
 * What the Claude Code capability contributes to the shell.
 *
 * A capability's ownership is one directory: its transport, the state it
 * derives from observed facts, and how it draws itself. Presence and the
 * Workspace view used to live in `app/workspace/`, which meant "what is Claude
 * Code" was answerable only by reading the app layer — the split #801's Phase 4
 * exists to close. The app layer still *registers* this and owns the
 * surrounding structure; PRINCIPLE #5 is what puts composition there and the
 * contribution here.
 *
 * The contract types are imported **type-only** on purpose. `CapabilityState`
 * and `WorkspaceViewBinding` belong to the surfaces being contributed to, which
 * sit above this layer, and a type-only reference is erased — it creates no
 * runtime edge and no cycle. The layer gate enforces exactly that distinction:
 * `capabilities → product` is an error for values and permitted for types.
 * Declaring the contribution by value belongs to the surface owner.
 */
import { Bot } from 'lucide-react';
import type { CapabilityFacts, CapabilityState } from '@/product/capability';
import type { WorkspaceViewBinding } from '@/app/workspace/workspaceContext';
import type { CapsuleProjectionBinding } from '@/app/capsuleProjections';
import type { CapabilityWorkBinding } from '@/app/workSignals';
import type { CapabilityConversationBinding } from '@/app/conversationIdentities';
import { ClaudeCodeWorkspace } from './components/ClaudeCodeWorkspace';
import { ClaudeCodeProjection } from './components/ClaudeCodeProjection';

export const CLAUDE_CODE_ID = 'claude-code';
export const CLAUDE_CODE_TITLE = 'Claude Code';

/**
 * Commands that mean "Claude Code is running here".
 *
 * `claude.exe` is the name the CLI actually runs under: the distributed package
 * installs its native binary as `bin/claude.exe`, and that is what the agent
 * reports as the pane's foreground command (measured against a real install).
 * The bare name covers installs that expose a plain `claude` wrapper.
 *
 * Deliberately excludes `node`: `claude` surfaces as `node` on some installs,
 * but so does every other node TUI, and a false positive would light Claude
 * Code up for unrelated work. Under-matching is the honest failure here.
 */
const CLAUDE_CODE_COMMANDS = ['claude', 'claude.exe'];

export function isClaudeCodeCommand(command: string): boolean {
  return CLAUDE_CODE_COMMANDS.includes(command);
}

/**
 * The one capability whose state comes from observation rather than
 * environment: the agent reports the session's foreground command, the app
 * layer records what it has seen, and this turns those facts into a state.
 *
 * `unavailable` without a session — there is no pane to have run anything.
 * `active` while the pane is running it, `relevant` once it has run here, and
 * `available` for a session that simply has not yet.
 */
export function resolveClaudeCodeState(
  facts: CapabilityFacts | undefined,
  sessionId: string | undefined,
): CapabilityState {
  if (!sessionId) {
    return 'unavailable';
  }

  const current = facts?.sessionForegroundCommand;
  if (current && isClaudeCodeCommand(current)) {
    return 'active';
  }

  const observed = facts?.sessionObservedCommands ?? [];
  return observed.some(isClaudeCodeCommand) ? 'relevant' : 'available';
}

/**
 * How the capability draws itself in the Workspace.
 *
 * Both experiences render the same view: Claude Code is a read-only config
 * browser, and its Web/App difference is the chrome around it, which the
 * experience compositions own — not something this binding branches on.
 */
export const claudeCodeView: WorkspaceViewBinding = {
  id: CLAUDE_CODE_ID,
  icon: Bot,
  layout: {
    web: ({ ctx }) => <ClaudeCodeWorkspace ctx={ctx} />,
    app: ({ ctx }) => <ClaudeCodeWorkspace ctx={ctx} />,
  },
};

/**
 * How Claude Code says something in the Terminal.
 *
 * **Both depths.** It is the capability whose state comes from observation, so
 * it is the one that emerges on its own — a pane running `claude.exe` gets the
 * Signal without anyone choosing it, which is Q1's second input made real.
 *
 * It **is** offered for selection, which it was not before `#1120`. The
 * argument for withholding it was that its richer surface is the Workspace
 * config browser and a Peek would summarise a list the Workspace already draws
 * better — true while the Workspace drew configuration and nothing else. Once
 * the conversation capability landed, what sits behind this capability is the
 * work itself rather than a manifest of it, and that is exactly what a Peek is
 * for. `#1046` stated the condition for its return; this is the return.
 */
export const claudeCodeProjection: CapsuleProjectionBinding = {
  id: CLAUDE_CODE_ID,
  entry: 'peek',
  body: ({ agentId, sessionId, depth, state, openWorkspace, openDetail }) => (
    <ClaudeCodeProjection
      agentId={agentId}
      sessionId={sessionId}
      depth={depth}
      state={state}
      onOpenWorkspace={openWorkspace}
      openDetail={openDetail}
    />
  ),
};

/**
 * What "Claude Code is working" means, contributed to the capsule's work
 * resolver (#1347 SC-14/19).
 *
 * Passive sensing: the agent already reports the pane's foreground command
 * with every session update, so a pane running Claude Code *is* the work
 * signal — no explicit API call. The matcher is the same one
 * `resolveClaudeCodeState` uses, and the summary text is this capability's
 * sentence to write; the shell aggregates without knowing either.
 */
export const claudeCodeWork: CapabilityWorkBinding = {
  id: CLAUDE_CODE_ID,
  sense: (facts) => {
    const command = facts?.sessionForegroundCommand;
    if (!command || !isClaudeCodeCommand(command)) {
      return null;
    }
    return {
      capabilityId: CLAUDE_CODE_ID,
      status: 'working',
      summary: 'Claude Code is running in this session',
    };
  },
};

/**
 * This capability's conversational identity, projected into the Workspace's
 * Terminal-return circle while the conversation is live (#1347 SC-25).
 *
 * The matcher is the same one the presence state and the work signal use —
 * one definition of "Claude is running", so the ring, the chip and the
 * destination glyph can never disagree about the same pane. The glyph is the
 * view's own icon: one icon per capability, drawn in place of the circle's
 * Terminal icon (*replace inner glyph*, never a badge).
 */
export const claudeCodeConversation: CapabilityConversationBinding = {
  id: CLAUDE_CODE_ID,
  sense: (facts) => {
    const command = facts?.sessionForegroundCommand;
    if (!command || !isClaudeCodeCommand(command)) {
      return null;
    }
    return { capabilityId: CLAUDE_CODE_ID, glyph: claudeCodeView.icon };
  },
};

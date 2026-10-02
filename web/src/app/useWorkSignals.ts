import { useMemo } from 'react';
import type { Session } from '@/types';
import { resolveWorkContext, type WorkSignal, type ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';

/**
 * Collect work signals from capabilities and aggregate into ResolvedWorkContext.
 *
 * This hook observes capability state and emits work signals when capabilities
 * are actively working. The signals are aggregated into a single context that
 * the capsule consumes to show the work ring.
 *
 * **Design:**
 * - Each capability provides its own work signal hook
 * - This hook collects all signals and resolves them
 * - Graceful degradation: if no signals, returns quiet context
 *
 * **Success Criteria:**
 * - SC-14: Working from active or passive capability sensing
 */
export function useWorkSignals(session: Session | undefined): ResolvedWorkContext {
  const claudeCodeSignal = useClaudeCodeWorkSignal(session);

  return useMemo(() => {
    const signals: WorkSignal[] = [claudeCodeSignal].filter(
      (signal): signal is WorkSignal => signal !== null,
    );
    return resolveWorkContext(signals);
  }, [claudeCodeSignal]);
}

/**
 * Claude Code work signal — emits 'working' when there's an active conversation.
 *
 * Observes the session's Claude Code conversation state. When a conversation is
 * active (not finished, not empty), returns a work signal. Otherwise returns null.
 *
 * **Rationale:**
 * - Claude Code is the primary conversational capability
 * - An active conversation represents ongoing work
 * - The signal is passive (observed from state), not active (no explicit API call)
 */
function useClaudeCodeWorkSignal(
  session: Session | undefined,
): WorkSignal | null {
  return useMemo(() => {
    if (!session) {
      return null;
    }

    // Check if Claude Code has an active conversation
    // This is a simplified check — in production, this would read from the
    // conversation state atom or plugin state
    const hasActiveConversation = Boolean(
      session.session_id &&
        // Placeholder: in real implementation, check conversation state
        // For now, return null to indicate no active work
        // TODO: Integrate with actual conversation state
        false,
    );

    if (!hasActiveConversation) {
      return null;
    }

    return {
      capabilityId: 'claude-code',
      status: 'working',
      summary: 'Active conversation',
    };
  }, [session]);
}

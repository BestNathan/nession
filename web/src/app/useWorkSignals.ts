import { useMemo } from 'react';
import { isClaudeCodeCommand } from '@/capabilities/claude-code';
import type { Session } from '@/types';
import {
  resolveWorkContext,
  type WorkSignal,
  type ResolvedWorkContext,
} from '@/product/terminal/capsule/workAwareness';

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
 * Claude Code work signal — passive sensing from the pane's foreground command.
 *
 * The agent already reports what the session's pane is running with every
 * session update; when that is a Claude Code process the capability is working,
 * so the signal fires without any explicit API call. The command matcher stays
 * owned by the claude-code capability — the same one `resolveClaudeCodeState`
 * uses — so "Claude is running" means the same thing in both places.
 */
function useClaudeCodeWorkSignal(
  session: Session | undefined,
): WorkSignal | null {
  const command = session?.foreground_command ?? null;
  return useMemo(() => {
    if (!command || !isClaudeCodeCommand(command)) {
      return null;
    }
    return {
      capabilityId: 'claude-code',
      status: 'working',
      summary: 'Claude Code is running in this session',
    };
  }, [command]);
}

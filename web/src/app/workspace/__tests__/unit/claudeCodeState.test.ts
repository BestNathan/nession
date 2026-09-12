import { describe, expect, it } from 'vitest';
import { resolveWorkspaceCapabilities } from '../../capabilities';
import type { WorkspaceContext } from '../../toolTypes';
import type { CapabilityFacts, CapabilityState } from '@/features/capabilities';

function workspaceContext(
  facts?: CapabilityFacts,
  withSession = true,
): WorkspaceContext {
  return {
    session: withSession
      ? ({ session_id: 'a1:work', agent_id: 'a1', session_name: 'work' } as never)
      : null,
    agent: { agent_id: 'a1' } as never,
    agents: [],
    domain: null,
    fileOps: null,
    experience: 'web',
    onToolChange: () => {},
    facts,
  };
}

function claudeCodeState(ctx: WorkspaceContext): CapabilityState | undefined {
  return resolveWorkspaceCapabilities(ctx).snapshots.find(
    (snapshot) => snapshot.id === 'claude-code',
  )?.state;
}

describe('claude-code capability state from session facts', () => {
  it('is unavailable without a session', () => {
    expect(claudeCodeState(workspaceContext(undefined, false))).toBe('unavailable');
  });

  it('is available for a session that has never run Claude Code', () => {
    expect(claudeCodeState(workspaceContext())).toBe('available');
  });

  it('is active while the session pane runs Claude Code', () => {
    expect(
      claudeCodeState(workspaceContext({ sessionForegroundCommand: 'claude' })),
    ).toBe('active');
  });

  it('matches the name the CLI actually runs under', () => {
    // The npm package installs the CLI as `bin/claude.exe` — that is the process
    // name tmux reports, so matching only the bare `claude` would leave the
    // capability dark for every real install (measured in the local stack).
    expect(
      claudeCodeState(workspaceContext({ sessionForegroundCommand: 'claude.exe' })),
    ).toBe('active');
  });

  it('stays relevant once Claude Code has run in this session', () => {
    expect(
      claudeCodeState(
        workspaceContext({
          sessionForegroundCommand: 'bash',
          sessionObservedCommands: ['claude', 'bash'],
        }),
      ),
    ).toBe('relevant');
  });

  it('does not treat a bare node process as Claude Code', () => {
    // `claude` can surface as `node` depending on how it was installed; guessing
    // there would light up Claude Code for every node TUI, so it stays unmatched.
    expect(
      claudeCodeState(workspaceContext({ sessionForegroundCommand: 'node' })),
    ).toBe('available');
  });

  it('falls back to available when the agent reports no foreground command', () => {
    expect(
      claudeCodeState(workspaceContext({ sessionForegroundCommand: null })),
    ).toBe('available');
  });
});

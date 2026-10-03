import { describe, expect, it } from 'vitest';
import {
  claudeCodeConversation,
  claudeCodeView,
  claudeCodeWork,
  resolveClaudeCodeState,
} from '../../contribution';
import type { CapabilityFacts, CapabilityState } from '@/product/capability';

const SESSION = 'a1:work';

/** `null` means "no session" — passing `undefined` would re-trigger the default. */
function state(facts?: CapabilityFacts, sessionId: string | null = SESSION): CapabilityState {
  return resolveClaudeCodeState(facts, sessionId ?? undefined);
}

/**
 * These used to reach the state through `resolveWorkspaceCapabilities`, because
 * the derivation lived in the app layer and the registry was the only way in.
 * It is capability knowledge, so it is tested where it lives — the registry
 * wiring keeps its own coverage in the app layer and in the capsule presence
 * tests, which still drive it end to end.
 */
describe('claude-code capability state from session facts', () => {
  it('is unavailable without a session', () => {
    expect(state(undefined, null)).toBe('unavailable');
  });

  it('is available for a session that has never run Claude Code', () => {
    expect(state()).toBe('available');
  });

  it('is active while the session pane runs Claude Code', () => {
    expect(state({ sessionForegroundCommand: 'claude' })).toBe('active');
  });

  it('matches the name the CLI actually runs under', () => {
    // The npm package installs the CLI as `bin/claude.exe` — that is the process
    // name tmux reports, so matching only the bare `claude` would leave the
    // capability dark for every real install (measured in the local stack).
    expect(state({ sessionForegroundCommand: 'claude.exe' })).toBe('active');
  });

  it('stays relevant once Claude Code has run in this session', () => {
    expect(
      state({ sessionForegroundCommand: 'bash', sessionObservedCommands: ['claude', 'bash'] }),
    ).toBe('relevant');
  });

  it('does not treat a bare node process as Claude Code', () => {
    // `claude` can surface as `node` depending on how it was installed; guessing
    // there would light up Claude Code for every node TUI, so it stays unmatched.
    expect(state({ sessionForegroundCommand: 'node' })).toBe('available');
  });

  it('falls back to available when the agent reports no foreground command', () => {
    expect(state({ sessionForegroundCommand: null })).toBe('available');
  });
});

/**
 * The work contribution (#1347 SC-14/19): the capability owns what "working"
 * means for it — matcher, status and summary — and the shell's resolver only
 * aggregates. Quiet is the absence of a signal, never a `{status:'quiet'}`
 * entry, or the Work Overview would fill with non-work.
 */
describe('claude-code work signal', () => {
  it('reports working while the pane runs Claude Code', () => {
    expect(claudeCodeWork.sense({ sessionForegroundCommand: 'claude.exe' })).toEqual({
      capabilityId: 'claude-code',
      status: 'working',
      summary: 'Working in this session',
    });
  });

  it('matches the bare command name too', () => {
    expect(claudeCodeWork.sense({ sessionForegroundCommand: 'claude' })?.status).toBe(
      'working',
    );
  });

  it('emits nothing for an unrelated command', () => {
    expect(claudeCodeWork.sense({ sessionForegroundCommand: 'bash' })).toBeNull();
  });

  it('emits nothing without facts', () => {
    expect(claudeCodeWork.sense(undefined)).toBeNull();
  });

  it('answers from the same matcher as the presence state', () => {
    // One definition of "Claude is running" — the ring and the presence chip
    // cannot disagree about the same pane.
    expect(claudeCodeWork.sense({ sessionForegroundCommand: 'node' })).toBeNull();
  });
});

/**
 * The conversational-identity contribution (#1347 SC-25): while the
 * conversation is live, the Workspace's Terminal-return circle draws this
 * capability's glyph in place of its Terminal icon. The capability owns the
 * matcher and the glyph; the shell only asks the registry.
 */
describe('claude-code conversation identity', () => {
  it('projects its identity while the pane runs Claude Code', () => {
    expect(
      claudeCodeConversation.sense({ sessionForegroundCommand: 'claude.exe' }),
    ).toEqual({ capabilityId: 'claude-code', glyph: claudeCodeView.icon });
  });

  it('matches the bare command name too', () => {
    expect(
      claudeCodeConversation.sense({ sessionForegroundCommand: 'claude' })?.capabilityId,
    ).toBe('claude-code');
  });

  it('projects nothing for an unrelated command', () => {
    expect(claudeCodeConversation.sense({ sessionForegroundCommand: 'bash' })).toBeNull();
  });

  it('projects nothing without facts', () => {
    expect(claudeCodeConversation.sense(undefined)).toBeNull();
  });

  it('answers from the same matcher as the presence state and the work signal', () => {
    // One definition of "Claude is running" — the chip, the ring and the
    // destination glyph cannot disagree about the same pane.
    expect(claudeCodeConversation.sense({ sessionForegroundCommand: 'node' })).toBeNull();
  });
});

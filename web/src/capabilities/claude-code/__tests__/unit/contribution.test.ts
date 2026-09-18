import { describe, expect, it } from 'vitest';
import { resolveClaudeCodeState } from '../../contribution';
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

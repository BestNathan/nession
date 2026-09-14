import { describe, expect, it } from 'vitest';
import { fixtureCapabilityFacts } from '@/app/fixture/fixtureCapabilityFacts';

describe('fixture capability facts', () => {
  it('provides no facts when the fixture route was not asked for any', () => {
    expect(fixtureCapabilityFacts('')).toBeUndefined();
    expect(fixtureCapabilityFacts('?other=1')).toBeUndefined();
  });

  it('expresses the pane command the session is running', () => {
    expect(fixtureCapabilityFacts('?pane=claude.exe')).toEqual({
      sessionForegroundCommand: 'claude.exe',
    });
  });

  it('expresses what the session was seen running before the current command', () => {
    // The current command is observed too — same rule the agent's updates
    // follow, so the fixture cannot produce a history the app could not.
    expect(fixtureCapabilityFacts('?pane=zsh&observed=claude.exe,bash')).toEqual({
      sessionForegroundCommand: 'zsh',
      sessionObservedCommands: ['claude.exe', 'bash', 'zsh'],
    });
  });

  it('ignores an empty observed list rather than inventing history', () => {
    expect(fixtureCapabilityFacts('?pane=zsh&observed=')).toEqual({
      sessionForegroundCommand: 'zsh',
    });
  });
});

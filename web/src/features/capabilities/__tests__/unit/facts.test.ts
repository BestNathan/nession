import { describe, expect, it } from 'vitest';
import { observeSessionCommand } from '../../facts';

describe('session command observation', () => {
  it('records the reported foreground command', () => {
    expect(observeSessionCommand(undefined, 'claude')).toEqual({
      sessionForegroundCommand: 'claude',
      sessionObservedCommands: ['claude'],
    });
  });

  it('keeps every distinct command the session has been seen running', () => {
    const afterClaude = observeSessionCommand(undefined, 'claude');
    expect(observeSessionCommand(afterClaude, 'bash')).toEqual({
      sessionForegroundCommand: 'bash',
      sessionObservedCommands: ['claude', 'bash'],
    });
  });

  it('does not grow when a command reappears', () => {
    const afterClaude = observeSessionCommand(undefined, 'claude');
    const afterBash = observeSessionCommand(afterClaude, 'bash');
    const backToClaude = observeSessionCommand(afterBash, 'claude');
    expect(backToClaude.sessionObservedCommands).toEqual(['bash', 'claude']);
    expect(backToClaude.sessionForegroundCommand).toBe('claude');
  });

  it('keeps history when the current command is unknown', () => {
    const afterClaude = observeSessionCommand(undefined, 'claude');
    expect(observeSessionCommand(afterClaude, null)).toEqual({
      sessionForegroundCommand: null,
      sessionObservedCommands: ['claude'],
    });
  });

  it('keeps observation history bounded', () => {
    let facts = observeSessionCommand(undefined, 'cmd-0');
    for (let i = 1; i < 40; i += 1) {
      facts = observeSessionCommand(facts, `cmd-${i}`);
    }
    expect(facts.sessionObservedCommands?.length).toBe(16);
  });
});

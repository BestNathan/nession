import { describe, it, expect } from 'vitest';
import { useTerminalStateMachine } from '../useTerminalStateMachine';

describe('useTerminalStateMachine', () => {
  it('exports a hook function', () => {
    expect(typeof useTerminalStateMachine).toBe('function');
  });
});

import { describe, expect, it } from 'vitest';
import { validateSessionName } from '../../createSessionValidation';

describe('validateSessionName', () => {
  it('accepts lowercase slugs', () => {
    for (const name of ['a', 'work', 'my-session', 'a.b_c-1', '123']) {
      expect(validateSessionName(name), name).toBeNull();
    }
  });

  it('rejects mixed case and names outside the lowercase slug', () => {
    for (const name of [
      'Test',
      'TEST',
      ' Test ',
      'test space',
      'a/b',
      'a:b',
      '.hidden',
      '-hidden',
      '_hidden',
      '中文',
    ]) {
      expect(validateSessionName(name), name).toContain('lowercase');
    }
  });

  it('refuses an absent name before the character rule', () => {
    expect(validateSessionName('   ')).toBe('Session name is required');
  });
});

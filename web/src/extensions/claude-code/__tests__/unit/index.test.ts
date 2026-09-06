import { describe, expect, it } from 'vitest';
import claudeCodeExtension from '@/extensions/claude-code';

describe('Claude Code extension registry entry', () => {
  it('keeps discovery metadata without exposing legacy UI slots', () => {
    expect(claudeCodeExtension.name).toBe('claude-code');
    expect(claudeCodeExtension.slots).toEqual({});
  });
});

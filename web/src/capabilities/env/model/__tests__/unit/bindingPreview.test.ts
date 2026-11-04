import { describe, it, expect } from 'vitest';
import {
  changedKeys,
  effectivePreview,
  type PreviewEntry,
} from '@/capabilities/env/model/bindingPreview';

function entry(name: string, content: string): PreviewEntry {
  return {
    ref: { name, source: 'server' },
    content,
    error: null,
  };
}

describe('bindingPreview', () => {
  it('applies later profiles last and names overlapping keys', () => {
    const preview = effectivePreview([
      entry('a.env', 'MODE=base\nONLY_A=1\n'),
      entry('b.env', 'MODE=staging\nONLY_B=2\n'),
    ]);
    expect(preview.values.get('MODE')).toBe('staging');
    expect(preview.keyCount).toBe(3);
    expect(preview.overlaps).toEqual(['MODE']);
  });

  it('reordering changes the effective value', () => {
    const forward = effectivePreview([
      entry('a.env', 'MODE=base\n'),
      entry('b.env', 'MODE=staging\n'),
    ]);
    const reverse = effectivePreview([
      entry('b.env', 'MODE=staging\n'),
      entry('a.env', 'MODE=base\n'),
    ]);
    expect(forward.values.get('MODE')).toBe('staging');
    expect(reverse.values.get('MODE')).toBe('base');
    expect(changedKeys(forward, reverse)).toEqual(['MODE']);
  });

  it('compares key additions, removals and value changes without exposing values', () => {
    const current = effectivePreview([entry('a.env', 'A=1\nB=2\n')]);
    const draft = effectivePreview([entry('a.env', 'A=1\nB=3\nC=4\n')]);
    expect(changedKeys(current, draft)).toEqual(['B', 'C']);
  });

  it('skips a profile whose content could not be read', () => {
    const preview = effectivePreview([
      entry('a.env', 'A=1\n'),
      { ref: { name: 'gone.env', source: 'server' }, content: null, error: 'unavailable' },
    ]);
    expect(preview.values.get('A')).toBe('1');
    expect(preview.keyCount).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn (classname merge)', () => {
  it('merges simple class strings', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('resolves Tailwind conflicts (later wins)', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });

  it('filters falsy values', () => {
    expect(cn('base', false && 'hidden', undefined, null, '', 0 && 'zero')).toBe('base');
  });

  it('handles conditional classes', () => {
    const active = true;
    const disabled = false;
    expect(cn('btn', active && 'btn-primary', disabled && 'opacity-50')).toBe('btn btn-primary');
  });

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('');
  });

  it('returns empty string for all falsy', () => {
    expect(cn(false && 'a', undefined, null, '')).toBe('');
  });

  it('deduplicates identical classes', () => {
    expect(cn('text-sm', 'text-sm')).toBe('text-sm');
  });
});

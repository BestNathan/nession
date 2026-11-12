import { describe, expect, it } from 'vitest';
import { experienceFromSearch } from '@/app/experienceMode';

describe('experienceFromSearch', () => {
  it('reads only the explicit Web/App values', () => {
    expect(experienceFromSearch('?experience=web')).toBe('web');
    expect(experienceFromSearch('?capability=git&experience=app')).toBe('app');
    expect(experienceFromSearch('?experience=WEB')).toBeUndefined();
    expect(experienceFromSearch('?experience=other')).toBeUndefined();
    expect(experienceFromSearch('')).toBeUndefined();
  });
});

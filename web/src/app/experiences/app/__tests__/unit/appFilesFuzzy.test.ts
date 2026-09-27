import { describe, expect, it } from 'vitest';
import { fuzzyMatchesFile } from '@/app/experiences/app/appFilesFuzzy';

describe('fuzzyMatchesFile', () => {
  it('matches empty query against any file', () => {
    expect(fuzzyMatchesFile('', 'app.tsx', 'src/app.tsx')).toBe(true);
    expect(fuzzyMatchesFile('   ', 'x', 'y')).toBe(true);
  });

  it('matches a subsequence on name or path', () => {
    expect(fuzzyMatchesFile('trm', 'Terminal.tsx', 'apps/web/src/Terminal.tsx')).toBe(true);
    expect(fuzzyMatchesFile('websrc', 'x', 'apps/web/src/x')).toBe(true);
  });

  it('rejects when no subsequence fits', () => {
    expect(fuzzyMatchesFile('zzzz', 'Terminal.tsx', 'src/Terminal.tsx')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  layoutFromLineCount,
  dockHeightFromLayout,
} from '@/session-first/capsule/types';

describe('composerLayout', () => {
  it('maps line counts to flat/stacked', () => {
    expect(layoutFromLineCount(0)).toBe('flat');
    expect(layoutFromLineCount(1)).toBe('flat');
    expect(layoutFromLineCount(2)).toBe('stacked');
    expect(layoutFromLineCount(5)).toBe('stacked');
  });

  it('maps layout to legacy dock height', () => {
    expect(dockHeightFromLayout('flat')).toBe('single');
    expect(dockHeightFromLayout('stacked')).toBe('multi');
  });
});

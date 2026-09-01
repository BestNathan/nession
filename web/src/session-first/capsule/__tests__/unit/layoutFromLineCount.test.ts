import { describe, it, expect } from 'vitest';
import {
  dockHeightFromLayout,
  layoutFromLineCount,
} from '@/session-first/capsule/measure/layoutFromLineCount';

describe('layoutFromLineCount', () => {
  it('maps line counts to flat or stacked', () => {
    expect(layoutFromLineCount(0)).toBe('flat');
    expect(layoutFromLineCount(1)).toBe('flat');
    expect(layoutFromLineCount(2)).toBe('stacked');
    expect(layoutFromLineCount(5)).toBe('stacked');
  });
});

describe('dockHeightFromLayout', () => {
  it('maps composer layout to legacy dock height', () => {
    expect(dockHeightFromLayout('flat')).toBe('single');
    expect(dockHeightFromLayout('stacked')).toBe('multi');
  });
});

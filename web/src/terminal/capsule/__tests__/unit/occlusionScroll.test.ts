import { describe, it, expect } from 'vitest';
import {
  isFollowingMarginBottom,
  marginLinesFromOcclusion,
  targetViewportY,
} from '@/terminal/capsule/occlusionScroll';

describe('occlusionScroll helpers', () => {
  it('converts occlusion px to whole-line margin', () => {
    expect(marginLinesFromOcclusion(0, 16)).toBe(0);
    expect(marginLinesFromOcclusion(48, 16)).toBe(3);
    expect(marginLinesFromOcclusion(49, 16)).toBe(4);
  });

  it('computes target viewport Y with margin', () => {
    expect(targetViewportY(40, 24, 0)).toBe(16);
    expect(targetViewportY(40, 24, 3)).toBe(13);
    expect(targetViewportY(10, 24, 3)).toBe(0);
  });

  it('detects follow-bottom vs history scroll', () => {
    const rows = 24;
    const length = 40;
    const margin = 3;
    const target = targetViewportY(length, rows, margin);

    expect(isFollowingMarginBottom(target, length, rows, margin)).toBe(true);
    expect(isFollowingMarginBottom(target - 1, length, rows, margin)).toBe(false);
    expect(isFollowingMarginBottom(16, 40, 24, 0)).toBe(true);
    expect(isFollowingMarginBottom(15, 40, 24, 0)).toBe(false);
  });
});

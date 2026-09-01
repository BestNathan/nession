import { describe, it, expect } from 'vitest';
import {
  CAPSULE_SINGLE_HEIGHT_PX,
  measureCapsuleLineCount,
} from '@/session-first/capsule/capsuleStyles';

describe('measureCapsuleLineCount', () => {
  it('forces 1 line when value is empty even if scrollHeight looks multi-line', () => {
    // Mobile empty textarea often reports >32px (placeholder / subpixel).
    expect(measureCapsuleLineCount('', 52)).toBe(1);
    expect(measureCapsuleLineCount('', 40)).toBe(1);
  });

  it('keeps single-line content at 1 when scrollHeight is within the single-line band', () => {
    expect(measureCapsuleLineCount('hello', CAPSULE_SINGLE_HEIGHT_PX)).toBe(1);
    expect(measureCapsuleLineCount('hello', CAPSULE_SINGLE_HEIGHT_PX + 2)).toBe(1);
  });

  it('counts hard breaks and real multi-line height', () => {
    expect(measureCapsuleLineCount('a\nb', 52)).toBe(2);
    expect(measureCapsuleLineCount('wraps without break', 52)).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MOBILE_BREAKPOINT,
  PROFILES,
  detectProfile,
} from '../DeviceProfile';

describe('DeviceProfile', () => {
  it('exposes presets for each device class', () => {
    expect(Object.keys(PROFILES)).toEqual(['mobile', 'desktop']);
    for (const profile of Object.values(PROFILES)) {
      expect(profile.fontSize).toBeGreaterThan(0);
      expect(profile.lineHeight).toBeGreaterThan(0);
      expect(profile.scrollback).toBeGreaterThan(0);
    }
  });

  it('detects mobile below the mobile breakpoint', () => {
    expect(detectProfile(MOBILE_BREAKPOINT - 1)).toBe('mobile');
  });

  it('detects desktop at or above the mobile breakpoint', () => {
    expect(detectProfile(MOBILE_BREAKPOINT)).toBe('desktop');
    expect(detectProfile(1024)).toBe('desktop');
    expect(detectProfile(1920)).toBe('desktop');
  });
});

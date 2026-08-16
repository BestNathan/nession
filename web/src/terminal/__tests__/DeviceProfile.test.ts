import { describe, expect, it } from 'vitest';
import {
  DESKTOP_BREAKPOINT,
  TABLET_BREAKPOINT,
  PROFILES,
  detectProfile,
} from '../DeviceProfile';

describe('DeviceProfile', () => {
  it('exposes presets for each device class', () => {
    expect(Object.keys(PROFILES)).toEqual(['desktop', 'tablet', 'phone']);
    for (const profile of Object.values(PROFILES)) {
      expect(profile.fontSize).toBeGreaterThan(0);
      expect(profile.lineHeight).toBeGreaterThan(0);
      expect(profile.scrollback).toBeGreaterThan(0);
    }
  });

  it('detects phone below the tablet breakpoint', () => {
    expect(detectProfile(TABLET_BREAKPOINT - 1)).toBe(PROFILES.phone);
  });

  it('detects tablet from the tablet breakpoint up to the desktop breakpoint', () => {
    expect(detectProfile(TABLET_BREAKPOINT)).toBe(PROFILES.tablet);
    expect(detectProfile(DESKTOP_BREAKPOINT - 1)).toBe(PROFILES.tablet);
  });

  it('detects desktop at or above the desktop breakpoint', () => {
    expect(detectProfile(DESKTOP_BREAKPOINT)).toBe(PROFILES.desktop);
  });
});

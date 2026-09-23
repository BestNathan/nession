import { describe, expect, it } from 'vitest';
import { TERMINAL_METRICS } from '../../../../../../design/generated/terminal';
import {
  MOBILE_BREAKPOINT,
  PROFILES,
  detectProfile,
} from '@/platform/terminal-runtime/DeviceProfile';

describe('DeviceProfile', () => {
  it('exposes presets for each device class', () => {
    expect(Object.keys(PROFILES)).toEqual(['mobile', 'desktop']);
    for (const profile of Object.values(PROFILES)) {
      expect(profile.fontSize).toBeGreaterThan(0);
      expect(profile.lineHeight).toBeGreaterThan(0);
      expect(profile.scrollback).toBeGreaterThan(0);
    }
  });

  // The point of the profile is that it selects an experience's metrics rather
  // than authoring them — the literals it used to hold (14 / 10 / 1.2) were the
  // drift this asserts against. Reading the same generated artifact the profile
  // reads is what makes the assertion about the *wiring*; the values themselves
  // are pinned by generate-tokens' own tests.
  it('takes type size and leading from the Experience tokens, not from itself', () => {
    expect(PROFILES.desktop.fontSize).toBe(TERMINAL_METRICS.web.fontSize);
    expect(PROFILES.desktop.lineHeight).toBe(TERMINAL_METRICS.web.lineHeight);
    expect(PROFILES.mobile.fontSize).toBe(TERMINAL_METRICS.app.fontSize);
    expect(PROFILES.mobile.lineHeight).toBe(TERMINAL_METRICS.app.lineHeight);
    // A device class differs from the other by *which* experience it selects;
    // if these ever coincide the mapping has stopped distinguishing them.
    expect(PROFILES.desktop.fontSize).not.toBe(PROFILES.mobile.fontSize);
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

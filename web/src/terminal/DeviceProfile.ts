import type { DeviceProfile } from './types';

export const PROFILES: Record<'desktop' | 'tablet' | 'phone', DeviceProfile> = {
  desktop: { fontSize: 14, lineHeight: 1.2, scrollback: 50000 },
  tablet:  { fontSize: 13, lineHeight: 1.2, scrollback: 30000 },
  phone:   { fontSize: 11, lineHeight: 1.1, scrollback: 10000 },
};

export const DESKTOP_BREAKPOINT = 1024;
export const TABLET_BREAKPOINT = 640;

/** Detect device class from container width in CSS pixels. */
export function detectProfile(containerWidth: number): DeviceProfile {
  if (containerWidth < TABLET_BREAKPOINT) { return PROFILES.phone; }
  if (containerWidth < DESKTOP_BREAKPOINT) { return PROFILES.tablet; }
  return PROFILES.desktop;
}

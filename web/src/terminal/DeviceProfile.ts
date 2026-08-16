import type { DeviceProfile, DeviceProfileConfig } from './types';

export const PROFILES: Record<DeviceProfile, DeviceProfileConfig> = {
  mobile:  { fontSize: 12, lineHeight: 1.2, scrollback: 10000 },
  desktop: { fontSize: 14, lineHeight: 1.2, scrollback: 50000 },
};

export const MOBILE_BREAKPOINT = 768;

/** Detect device class from container width in CSS pixels. */
export function detectProfile(containerWidth: number): DeviceProfile {
  if (containerWidth < MOBILE_BREAKPOINT) { return 'mobile'; }
  return 'desktop';
}

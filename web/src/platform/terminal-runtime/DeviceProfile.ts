import { TERMINAL_METRICS } from '../../../../design/generated/terminal';
import type { DeviceProfile, DeviceProfileConfig } from './types';

/**
 * Device-class terminal profiles.
 *
 * Type size and leading are **not** decided here. They are Experience
 * presentation values — `experience.web.terminal` / `experience.app.terminal` —
 * crossed to xterm through the generated `TERMINAL_METRICS`, because xterm reads
 * `fontSize` and `lineHeight` as JS options rather than as custom properties.
 * `terminal-surface.md` §Resize and typography is the rule: "font/scrollback/
 * control metrics come from Experience tokens, not ad-hoc breakpoint values".
 * A device class only *selects* the experience whose metrics apply; it does not
 * author them, so changing the terminal's type means editing the token source,
 * not this file.
 *
 * `scrollback` stays a device decision on purpose: it is an xterm buffer budget
 * (how much history a phone can hold) rather than a presentation value, and no
 * token owns it.
 */
export const PROFILES: Record<DeviceProfile, DeviceProfileConfig> = {
  mobile: {
    fontSize: TERMINAL_METRICS.app.fontSize,
    lineHeight: TERMINAL_METRICS.app.lineHeight,
    scrollback: 10000,
  },
  desktop: {
    fontSize: TERMINAL_METRICS.web.fontSize,
    lineHeight: TERMINAL_METRICS.web.lineHeight,
    scrollback: 50000,
  },
};

export const MOBILE_BREAKPOINT = 768;

/** Detect device class from container width in CSS pixels. */
export function detectProfile(containerWidth: number): DeviceProfile {
  if (containerWidth < MOBILE_BREAKPOINT) { return 'mobile'; }
  return 'desktop';
}

export type ExperienceMode = 'web' | 'app';

/**
 * Read an explicit experience mode from a query string.
 *
 * The default composition is a **viewport** decision: wide is Web, narrow is
 * the App spatial shell. #2851 also needs the Web composition to be reachable
 * at a narrow width (its overlay drawer), without making the App lose its own
 * narrow default. `experience=web|app` is that explicit route: it selects the
 * composition, while the viewport still selects the geometry inside it.
 *
 * Only the two exact values are meaningful. Anything else is the default, which
 * keeps an accidental parameter from changing the shell.
 */
export function experienceFromSearch(search: string): ExperienceMode | undefined {
  const value = new URLSearchParams(search).get('experience');
  return value === 'web' || value === 'app' ? value : undefined;
}

/**
 * The current URL's explicit mode, checking the normal query and the hash
 * query the fixture routes use. Absent means "use the viewport default".
 */
export function currentExperienceMode(): ExperienceMode | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const direct = experienceFromSearch(window.location.search);
  if (direct !== undefined) {
    return direct;
  }
  const queryIndex = window.location.hash.indexOf('?');
  return queryIndex < 0
    ? undefined
    : experienceFromSearch(window.location.hash.slice(queryIndex));
}

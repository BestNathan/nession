/**
 * The App experience's typography roles, as class strings (#1073, #1216).
 *
 * Re-exports the shared chrome role recipes so App-owned surfaces pick a *role*
 * instead of Tailwind size/weight literals. Experience-specific metrics resolve
 * through `--typography-*` under `[data-experience="app"]`.
 *
 * Work surfaces stay out of this scale: xterm reads `experience.app.terminal`,
 * CodeMirror reads `workspace.editorFontSize`, and markdown document typography
 * is document-owned.
 */

import {
  type ChromeTypographyRole,
  chromeMonoRole,
  chromeSansRole,
} from '@/shared/typography/chromeRoles';

function appRole(role: ChromeTypographyRole, family: 'sans' | 'mono' = 'sans'): string {
  return family === 'mono' ? chromeMonoRole(role) : chromeSansRole(role);
}

/** The page's own name: Session title, Workspace tool title, pushed detail title. */
export const titleAppClass = appRole('title');

/** The row the surface exists for: a Session name, a file name. */
export const primaryAppClass = appRole('primary');

/** Controls and ordinary actions — a control's size follows its job, not its primitive. */
export const bodyAppClass = appRole('body');

/** Supporting but fully readable: a node row under a section label. */
export const secondaryAppClass = appRole('secondary');

/** Quiet: recency, counts, section labels, the footer's service state. */
export const metadataAppClass = appRole('metadata');

/** Lowest deliberate readable hierarchy on App chrome. */
export const captionAppClass = appRole('caption');

/** Chrome-side technical identity: the path above the tree, the file header. */
export const codeAppClass = appRole('code');

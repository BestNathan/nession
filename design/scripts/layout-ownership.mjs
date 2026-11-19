import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatViolation } from './design-gate.mjs';
import { LAYOUT_RECIPE_OWNER, isTokenOwnedRecipe } from './recipe-style-owners.mjs';
export { LAYOUT_RECIPE_OWNER };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', '..');

/**
 * Layout ownership rules (#3194).
 *
 * The invariant is ownership, not syntax. `flex`, `grid`, `min-w-0`,
 * `min-h-0`, `flex-1`, `items-center` and conditional `cn()` remain legal
 * inside capability content — they are mechanisms. What this check owns is the
 * smaller, mechanically decidable set of ways a consumer can take over a host
 * role:
 *
 * - the Experience frame's page geometry (`h-screen`, `h-[100dvh]`,
 *   `fixed inset-0`, …);
 * - the App's one page header/Back;
 * - the Workspace host's own shell/tool chrome;
 * - a stable shared recipe restated locally.
 *
 * The canonical owners live in `docs/design/composition.md` §14 and
 * `web/src/app/workspace/layout/workspaceLayout.tsx`. A violation names both
 * the expected owner and the repair.
 */

export const MASTER_DETAIL_MARKER =
  'grid-cols-[var(--nession-workspace-tree-width)_minmax(0,1fr)]';
export const SCROLL_OWNER_MARKER = 'data-workspace-scroll-owner';
/**
 * The App Experience's keyboard-avoidance scroll ancestor (#3523).
 *
 * A soft keyboard changes the visible region, not the Terminal's layout size.
 * Exactly one Experience owner may publish this scroll owner; capability-local
 * code claiming it would create a second outer scroll that competes with the
 * active layer and can feed scroll/viewport movement into terminal geometry.
 */
export const KEYBOARD_SCROLL_OWNER_MARKER = 'data-keyboard-avoidance-scrollport';
export const KEYBOARD_SCROLL_OWNER_SYMBOL = 'KEYBOARD_AVOIDANCE_SCROLLPORT_ATTRIBUTE';
export const KEYBOARD_SCROLL_OWNER_FILE =
  'web/src/app/experiences/app/AppKeyboardAvoidanceScrollport.tsx';
/**
 * The only module allowed to read `window.visualViewport` (#3523).
 *
 * The App environment publishes one shell-local layout/visible/occlusion
 * snapshot. A second reader anywhere else — capability content, the terminal
 * runtime, or a surface that then feeds a "keyboard height" into rows — is a
 * competing owner and breaks the geometry firewall.
 */
export const APP_VIEWPORT_OWNER_ROOT = 'web/src/platform/viewport/';
export const VISUAL_VIEWPORT_READ_RE = /\bwindow\.visualViewport\b|\bvisualViewport\b/g;

const CONTENT_ROOTS = ['web/src/capabilities/', 'web/src/product/'];
const FRAME_UTILITY_RE =
  /\b(?:h-screen|min-h-screen|w-screen|h-\[100dvh\]|min-h-\[100dvh\]|fixed\s+inset-0|fixed\s+inset-x-0)\b/g;
const HEADER_MARKER_RE = /\bAppPageHeader\b|data-testid="app-page-header"/g;
const HOST_CHROME_MARKERS = [
  'workspace-shell',
  'workspace-tool-bar',
  'workspace-tool-content',
  'workspace-surface-navigation',
];
/** Token-only spacing applies to Nession-owned shared recipes, not the upstream
 * internals of every shadcn primitive or the glyphs of a third-party renderer.
 * This is the same owner as the existing no-recipe-raw-spacing check (#3194).
 * A broader legacy product/capability migration must be explicitly audited.
 */
const SPACING_PREFIX = '(?:gap(?:-[xy])?|space-[xy]|p[trblxy]?|m[trblxy]?|w|h|size)';
const RAW_SPACING_RE = new RegExp(
  `(?<![\\w-])-?${SPACING_PREFIX}-(?:(?:-?\\d+(?:\\.\\d+)?|px)(?![\\w.-])|\\[-?\\d+(?:\\.\\d+)?(?:px|rem|em|vh|vw|%|ch|dvh)?\\])`,
  'g',
);
const RAW_CALC_LENGTH_RE = new RegExp(
  `(?<![\\w-])${SPACING_PREFIX}-\\[[^\\]\\n]*?(?:\\d+(?:\\.\\d+)?)(?:px|rem|em|vh|vw|dvh|%)\\b[^\\]\\n]*?\\]`,
  'g',
);
const RAW_INLINE_VISUAL_RE =
  /(?<![\w-])(?:padding(?:Top|Bottom|Left|Right|Inline|Block)?|margin(?:Top|Bottom|Left|Right|Inline|Block)?|gap|rowGap|columnGap|width|height|fontSize|borderRadius)\s*:\s*['"]?-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)?/g;

const RULES = {
  'no-capability-frame-geometry': {
    expected:
      'page/surface geometry is owned by the Experience composition (WebLayout / AppLayout / AppLayers / ShellMain / WorkspacePanel)',
    owner: 'docs/design/composition.md §14 + web/src/app/experiences/*',
    repair:
      'remove host sizing or page geometry from capability content; let the Experience frame own it and keep local flex/grid for the content itself',
  },
  'no-capability-app-header': {
    expected: 'one AppPageHeader/Back per depth, rendered by the App host composition',
    owner: 'web/src/app/patterns/AppPageHeader.tsx + web/src/app/WorkspacePanel.tsx',
    repair:
      'remove the capability-local page header/Back; the App experience and WorkspacePanel render the one host header',
  },
  'no-capability-host-chrome': {
    expected: 'Workspace shell/tool chrome is owned by the app/workspace layer',
    owner: 'web/src/app/workspace/WorkspaceShell.tsx',
    repair:
      'render the capability content only; the Workspace host publishes its shell, tool bar and surface navigation',
  },
  'no-duplicated-master-detail': {
    expected: 'the stable master/detail grid is owned by WorkspaceMasterDetail',
    owner: LAYOUT_RECIPE_OWNER,
    repair:
      'render <WorkspaceMasterDetail navigation={...}> instead of restating the stable grid class',
  },
  'no-duplicated-scroll-owner': {
    expected: 'the host Workspace scroll owner is owned by WorkspaceScrollRegion',
    owner: LAYOUT_RECIPE_OWNER,
    repair:
      'use <WorkspaceScrollRegion> (or a locally justified inner scroll container); do not publish the host scroll marker',
  },
  'no-recipe-raw-spacing': {
    expected:
      'the shared layout recipes use token-backed spacing or no spacing at all; stable spacing belongs to a semantic token',
    owner: 'design/tokens/experience/{web,app}.json + the shared recipe owner',
    repair:
      'replace the raw visual metric with an existing --nession-* token; if no semantic metric exists, add it to the canonical Experience token graph and regenerate projections',
  },
  'no-foreign-keyboard-scroll-owner': {
    expected:
      'the App Experience owns one keyboard-avoidance scroll ancestor for the active layer',
    owner: KEYBOARD_SCROLL_OWNER_FILE + ' + docs/design/composition.md §14',
    repair:
      'remove the keyboard scroll-owner marker from capability/product code; let AppLayout/ShellMain host the one Experience scrollport',
  },
  'no-foreign-visual-viewport': {
    expected:
      'only the App viewport environment reads window.visualViewport and publishes layout/visible/occlusion snapshots',
    owner: APP_VIEWPORT_OWNER_ROOT,
    repair:
      'consume the published App viewport snapshot (or a surface-owned clearance) instead of reading visualViewport directly; never feed a visual-viewport height into terminal rows',
  },
};

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

/**
 * Replace comments with spaces while preserving offsets/newlines.
 *
 * The scan is about what code ships; a doc comment that names `h-screen` is
 * explanation, not a host-geometry bypass.
 */
export function maskComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

function isTestSource(file) {
  return file.includes('/__tests__/') || /\.(?:test|spec)\.[^.]+$/.test(file);
}

function isContentSource(file) {
  return CONTENT_ROOTS.some((prefix) => file.startsWith(prefix));
}

function pushOccurrences(violations, masked, regex, { file, rule, actualOf }) {
  for (const match of masked.matchAll(regex)) {
    violations.push({
      file,
      line: lineNumber(masked, match.index),
      kind: rule,
      actual: actualOf ? actualOf(match) : match[0],
      ...RULES[rule],
    });
  }
}

/**
 * Scan one source file.
 *
 * Exported so the design source tests can prove both the reject and the
 * accept side without a repository mutation.
 */
export function scanLayoutSource(source, file = '<fixture>') {
  if (isTestSource(file)) return [];
  const masked = maskComments(source);
  const violations = [];

  if (isContentSource(file)) {
    pushOccurrences(violations, masked, FRAME_UTILITY_RE, {
      file,
      rule: 'no-capability-frame-geometry',
    });
    pushOccurrences(violations, masked, HEADER_MARKER_RE, {
      file,
      rule: 'no-capability-app-header',
    });
    for (const marker of HOST_CHROME_MARKERS) {
      if (!masked.includes(marker)) continue;
      violations.push({
        file,
        line: lineNumber(masked, masked.indexOf(marker)),
        kind: 'no-capability-host-chrome',
        actual: marker,
        ...RULES['no-capability-host-chrome'],
      });
    }
  }

  if (file !== LAYOUT_RECIPE_OWNER) {
    if (masked.includes(MASTER_DETAIL_MARKER)) {
      violations.push({
        file,
        line: lineNumber(masked, masked.indexOf(MASTER_DETAIL_MARKER)),
        kind: 'no-duplicated-master-detail',
        actual: MASTER_DETAIL_MARKER,
        ...RULES['no-duplicated-master-detail'],
      });
    }
    if (masked.includes(SCROLL_OWNER_MARKER)) {
      violations.push({
        file,
        line: lineNumber(masked, masked.indexOf(SCROLL_OWNER_MARKER)),
        kind: 'no-duplicated-scroll-owner',
        actual: SCROLL_OWNER_MARKER,
        ...RULES['no-duplicated-scroll-owner'],
      });
    }
  }

  if (isTokenOwnedRecipe(file)) {
    for (const regex of [RAW_SPACING_RE, RAW_CALC_LENGTH_RE, RAW_INLINE_VISUAL_RE]) {
      pushOccurrences(violations, masked, regex, {
        file,
        rule: 'no-recipe-raw-spacing',
      });
    }
  }

  // Keyboard avoidance has one Experience owner and one viewport reader
  // (#3523). Both checks are deliberately narrow: they reject a second owner,
  // not a component's local flex/grid, and the environment's own module is the
  // documented exception.
  if (file !== KEYBOARD_SCROLL_OWNER_FILE
    && !file.startsWith(APP_VIEWPORT_OWNER_ROOT)) {
    for (const marker of [KEYBOARD_SCROLL_OWNER_MARKER, KEYBOARD_SCROLL_OWNER_SYMBOL]) {
      if (!masked.includes(marker)) continue;
      violations.push({
        file,
        line: lineNumber(masked, masked.indexOf(marker)),
        kind: 'no-foreign-keyboard-scroll-owner',
        actual: marker,
        ...RULES['no-foreign-keyboard-scroll-owner'],
      });
    }
  }
  if (!file.startsWith(APP_VIEWPORT_OWNER_ROOT)) {
    pushOccurrences(violations, masked, VISUAL_VIEWPORT_READ_RE, {
      file,
      rule: 'no-foreign-visual-viewport',
    });
  }

  return violations;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

export function scanRepository(root = ROOT) {
  const violations = [];
  for (const path of walk(join(root, 'web', 'src'))) {
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(extname(path))) continue;
    const file = relative(root, path).replaceAll('\\', '/');
    violations.push(...scanLayoutSource(readFileSync(path, 'utf8'), file));
  }
  return violations;
}

function format(violation) {
  return formatViolation({
    file: violation.file,
    pattern: violation.kind,
    rule: 'layout-ownership',
    actual: violation.actual,
    expected: violation.expected,
    owner: violation.owner,
    repair: violation.repair,
    note: `line ${violation.line}`,
  });
}

function main() {
  const violations = scanRepository(ROOT);
  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`${format(violation)}\n\n`);
    process.stderr.write(`✗ ${violations.length} layout ownership violation(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('✓ layout-ownership\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

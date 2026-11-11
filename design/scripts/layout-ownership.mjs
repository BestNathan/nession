import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatViolation } from './design-gate.mjs';

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

export const LAYOUT_RECIPE_OWNER = 'web/src/app/workspace/layout/workspaceLayout.tsx';
export const MASTER_DETAIL_MARKER =
  'grid-cols-[var(--nession-workspace-tree-width)_minmax(0,1fr)]';
export const SCROLL_OWNER_MARKER = 'data-workspace-scroll-owner';

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
const RAW_SPACING_RE =
  /(?<![\w-])(?:gap|gap-x|gap-y|space-x|space-y|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml)-\d+(?:\.\d+)?(?![\w-])/g;

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
    owner: LAYOUT_RECIPE_OWNER,
    repair:
      'replace the numeric spacing with a token-backed arbitrary value (var(--nession-*)) or leave spacing to the local consumer',
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
  } else {
    pushOccurrences(violations, masked, RAW_SPACING_RE, {
      file,
      rule: 'no-recipe-raw-spacing',
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

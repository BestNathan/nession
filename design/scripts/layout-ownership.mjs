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
/**
 * The retired capability-level Capsule clearance (#4115).
 *
 * Before the App host owned the page scroll, every capability that could reach
 * the pane bottom opted in with this trailing padding. The host now spends its
 * own measured inset; a capability reintroducing either the class or the raw
 * variable is restoring a second owner.
 */
const RETIRED_CLEARANCE_RE =
  /\bworkspaceScrollClearanceClass\b|pb-\[var\(--nession-local-workspace-content-bottom-inset/g;
/**
 * A capability scroll owner hardcoding a fixed Capsule-sized bottom band
 * (#4188).
 *
 * `pb-16` on a nested list/reader was the concrete regression: a number chosen
 * for the overlay cannot track a dynamic Capsule or viewport, and it competes
 * with the host's measured inset. The check is deliberately narrow — it only
 * looks at one element that is itself a vertical scroll owner and only rejects
 * a band large enough to stand in for overlay clearance; small paddings remain
 * ordinary content spacing.
 */
const JSX_TAG_RE = /<[A-Za-z][^<>]*>/g;
const VERTICAL_SCROLL_OVERFLOW_RE = /\boverflow-(?:y-)?(?:auto|scroll)\b/;
const FIXED_BOTTOM_BAND_RE = /\bpb-(?:1[0-9]|[2-9]\d|\d{3,})\b/g;
/**
 * A capability-owned App page scroll (#4115).
 *
 * The App host owns the default page scroll owner. An element whose testid
 * names an App layout/workspace root and that carries a vertical scroll is the
 * pattern the host contract removes — a declared bounded view uses the shared
 * bounded class and a non-root marker instead.
 */
const APP_PAGE_SCROLL_RE =
  /data-testid=(?:"[^"]*-(?:app-layout|app-workspace|app-workspace-scroll)"|\{`[^`]*-(?:app-layout|app-workspace)`\})[^>]*overflow-(?:y-)?auto|overflow-(?:y-)?auto[^>]*data-testid=(?:"[^"]*-(?:app-layout|app-workspace|app-workspace-scroll)"|\{`[^`]*-(?:app-layout|app-workspace)`\})/g;
/**
 * The host's App surface marker is published by the layout recipe alone. A
 * capability that writes it is claiming to be the App scroll surface rather
 * than contributing content to it.
 */
const APP_SURFACE_MARKER = 'data-workspace-app-surface';
/**
 * The reusable bounded scrollport recipe (#4222 SC-01).
 *
 * The measured clearance lives on the scrolling viewport, never on the same
 * element as caller content spacing: `p-2` and `pb-6` would otherwise win
 * Tailwind's merge and erase the host inset. Capability code consumes the
 * recipe; only its owner and the documented third-party viewport adapter may
 * name the class directly.
 */
export const WORKSPACE_SCROLLPORT_OWNER =
  'web/src/components/ui/workspace-scrollport.tsx';
const BOUNDED_CLEARANCE_ADAPTERS = new Set([
  WORKSPACE_SCROLLPORT_OWNER,
  LAYOUT_RECIPE_OWNER,
  'web/src/shared/lib/workspaceScrollClearance.ts',
  // A virtualized/third-party viewport that owns its own scroll machinery but
  // still spends the Workspace inset (MessageScroller is the canonical one).
  'web/src/shared/ai-conversation/components/ConversationTranscript.tsx',
]);
const BOUNDED_CLEARANCE_RE =
  /\bworkspaceBoundedScrollClearanceClass\b|pb-\[var\(--nession-local-workspace-scroll-bottom-inset/g;
/** A persistent sibling outside the scroll area, declared to the host (#4222). */
const FIXED_ROLE_MARKER = 'data-workspace-fixed-role';
const SCROLL_COVERAGE_FILE = 'web/src/app/workspace/scrollCoverage.ts';
const FRAME_UTILITY_RE =
  /\b(?:h-screen|min-h-screen|w-screen|h-dvh|min-h-dvh|h-svh|min-h-svh|h-lvh|min-h-lvh|w-dvw|h-\[100dvh\]|min-h-\[100dvh\]|h-\[100svh\]|min-h-\[100svh\]|h-\[100lvh\]|min-h-\[100lvh\]|w-\[100dvw\]|fixed\s+inset-0|fixed\s+inset-x-0|fixed\s+inset-y-0)(?![\w-])/g;
const HEADER_MARKER_RE =
  /\bAppPageHeader\b|\bAppBackButton\b|\bAppHeaderActions\b|\bAppStackSheet\b|data-testid="(?:app-page-header|app-page-back|app-page-titleblock|app-page-subtitle|app-page-actions|app-page-more|app-page-action-[^"]*|app-header-workspace|app-tool-header|app-tool-back|files-app-nav|files-app-back)"/g;
/**
 * The App experience's gesture coordinator and its observable contract (#3971).
 *
 * `Sessions ← Terminal → Workspace` plus the Workspace inner stack is one
 * arbitration: platform guard → interactive/work surface → Workspace stack →
 * outer pager. A capability contributes destinations and leave guards; it must
 * not install a second mark or import the pager's engine, because that is how
 * one contact acquires two owners. `data-swipe-owner` is the explicit
 * capability-side escape hatch and stays legal.
 */
export const APP_GESTURE_OWNER_ROOT = 'web/src/app/experiences/app/';
export const APP_GESTURE_IMPORT_RE =
  /from\s+['"]@\/app\/experiences\/app\/(?:edgeBand|gesture|swipeGesture|swipeTouchBinding|useSwipePager|useSwipeSettle|workSurface|appLayerPositions)['"]/g;
export const GESTURE_MARKER_RE =
  /\bdata-(?:swipe-phase|swipe-destination(?:-label)?|swipe-inner|swipe-reason|swipe-guard-px|workspace-stack-(?:pop|forward))\b/g;
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
  `(?<![\\w-])${SPACING_PREFIX}-\\[(?:calc|clamp|min|max)\\([^\\]\\n]*?\\d+(?:\\.\\d+)?(?:px|rem|em|vh|vw|dvh|%)[^\\]\\n]*?\\]`,
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
  'no-capability-gesture-ownership': {
    expected:
      'one App gesture coordinator routes each contact through platform guard → work surface → Workspace inner stack → outer pager',
    owner:
      'web/src/app/experiences/app/{useSwipePager,swipeGesture,useSwipeSettle,swipeTouchBinding,workSurface,edgeBand}.ts + web/src/app/workspace/appInnerStackMotion.ts',
    repair:
      'contribute destinations through WorkspaceDepthControl (setPush/setForward) and declare a surface with data-swipe-owner; never publish the shell swipe markers or import the pager engine from capability/product content',
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
  'no-capability-capsule-clearance-opt-in': {
    expected:
      'the App host owns the page scrollport and spends its measured Capsule clearance; a bounded capability surface spends workspaceBoundedScrollClearanceClass inside a declared adapter',
    owner: 'web/src/app/workspace/layout/workspaceLayout.tsx + web/src/shared/lib/workspaceScrollClearance.ts',
    repair:
      'remove the capability-level clearance padding; contribute content to the App host scrollport, or declare appScroll: "bounded" and use the bounded surface class at your own internal scroller',
  },
  'no-capability-fixed-scroll-clearance': {
    expected:
      'a capability scroll owner spends the host-measured bounded inset; it does not hardcode a Capsule-sized bottom band',
    owner:
      'web/src/shared/lib/workspaceScrollClearance.ts + web/src/app/workspace/layout/workspaceLayout.tsx',
    repair:
      'remove the fixed pb-* band; use workspaceBoundedScrollClearanceClass on the declared bounded scroll owner',
  },
  'no-capability-app-page-scroll': {
    expected:
      'one App primary vertical scroll owner, rendered by the host (AppWorkspaceScrollRegion) or by a declared bounded adapter',
    owner: LAYOUT_RECIPE_OWNER + ' + docs/design/composition.md §14',
    repair:
      'remove the page-level scroll from the App layout root; let the host scroll the page, or declare the view appScroll: "bounded" and put a marked internal scroller inside it',
  },
  'no-coupled-bounded-scrollport': {
    expected:
      'a bounded scroll owner spends the host-measured inset on its viewport, never on the same element as caller content spacing',
    owner:
      'web/src/components/ui/workspace-scrollport.tsx + web/src/shared/lib/workspaceScrollClearance.ts',
    repair:
      'render <WorkspaceBoundedScrollport viewportClassName={...} className={...}> so content padding cannot override the measured bottom inset; keep the class only in the recipe owner or a declared third-party viewport adapter',
  },
  'no-unregistered-fixed-workspace-footer': {
    expected:
      'a persistent sibling footer is declared to the host, which measures and clears it; ordinary notes and status rows live inside the scroll area',
    owner:
      'web/src/app/workspace/scrollCoverage.ts + web/src/app/workspace/hooks/useWorkspaceCapsuleClearance.ts',
    repair:
      'move the note/status inside the bounded scroller, or mark an intentionally fixed context with data-workspace-fixed-role="context" and list it in the route coverage',
  },
  'no-capability-app-surface-owner': {
    expected: 'the App Workspace surface marker is published by the host layout recipe',
    owner: LAYOUT_RECIPE_OWNER,
    repair:
      'remove the host surface marker from capability content; the host decides whether this view scrolls as a document or a bounded surface',
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
    // An explicit zero gap/inset is a valid structural relationship (e.g. a
    // continuous list). Only non-zero visual decisions need a design token.
    if (rule === 'no-recipe-raw-spacing' && (/-0$/.test(match[0]) || /:\s*['"]?0$/.test(match[0]))) continue;
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
    // #4115: the host owns the App page scroll and its Capsule clearance.
    pushOccurrences(violations, masked, RETIRED_CLEARANCE_RE, {
      file,
      rule: 'no-capability-capsule-clearance-opt-in',
    });
    // #4222: a persistent sibling footer must declare itself; an ordinary
    // note/status row belongs inside the scroll area where it is reachable.
    for (const tag of masked.matchAll(JSX_TAG_RE)) {
      if (!/\bshrink-0\b/.test(tag[0]) || !/\bborder-t\b/.test(tag[0])) continue;
      if (tag[0].includes(FIXED_ROLE_MARKER)) continue;
      violations.push({
        file,
        line: lineNumber(masked, tag.index),
        kind: 'no-unregistered-fixed-workspace-footer',
        actual: tag[0].slice(0, 80),
        ...RULES['no-unregistered-fixed-workspace-footer'],
      });
    }
    // #4188: a scroll owner that hardcodes a Capsule-sized band is a second
    // clearance owner. Checked per element so a small padding elsewhere or on
    // a non-scrolling box stays legal.
    for (const tag of masked.matchAll(JSX_TAG_RE)) {
      if (!VERTICAL_SCROLL_OVERFLOW_RE.test(tag[0])) continue;
      const band = tag[0].match(FIXED_BOTTOM_BAND_RE);
      if (!band) continue;
      violations.push({
        file,
        line: lineNumber(masked, tag.index),
        kind: 'no-capability-fixed-scroll-clearance',
        actual: band[0],
        ...RULES['no-capability-fixed-scroll-clearance'],
      });
    }
    pushOccurrences(violations, masked, APP_PAGE_SCROLL_RE, {
      file,
      rule: 'no-capability-app-page-scroll',
    });
    if (masked.includes(APP_SURFACE_MARKER)) {
      violations.push({
        file,
        line: lineNumber(masked, masked.indexOf(APP_SURFACE_MARKER)),
        kind: 'no-capability-app-surface-owner',
        actual: APP_SURFACE_MARKER,
        ...RULES['no-capability-app-surface-owner'],
      });
    }
    if (!file.startsWith(APP_GESTURE_OWNER_ROOT)) {
      pushOccurrences(violations, masked, APP_GESTURE_IMPORT_RE, {
        file,
        rule: 'no-capability-gesture-ownership',
      });
      pushOccurrences(violations, masked, GESTURE_MARKER_RE, {
        file,
        rule: 'no-capability-gesture-ownership',
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

  // #4222: one reusable bounded scrollport. A file that restates the measured
  // clearance on the same element as content spacing is restoring the defect
  // the recipe removes; third-party viewports and the recipe owner are the
  // declared exceptions.
  if (!BOUNDED_CLEARANCE_ADAPTERS.has(file)) {
    pushOccurrences(violations, masked, BOUNDED_CLEARANCE_RE, {
      file,
      rule: 'no-coupled-bounded-scrollport',
    });
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

/**
 * Parse the scroll-coverage inventory (#4222 SC-03).
 *
 * The inventory is TypeScript the Gate cannot import, so the parser reads only
 * the shapes that file deliberately keeps regular: one `capability` per entry,
 * then one flat route object per reachable variant.
 */
export function parseScrollCoverageSource(source) {
  const entries = [];
  const capabilityMatches = [...source.matchAll(/capability:\s*'([^']+)'/g)];
  for (let index = 0; index < capabilityMatches.length; index += 1) {
    const start = capabilityMatches[index].index;
    const end = index + 1 < capabilityMatches.length
      ? capabilityMatches[index + 1].index
      : source.length;
    const block = source.slice(start, end);
    const routeMatches = [...block.matchAll(/route:\s*'([^']+)'/g)];
    const routes = [];
    for (let routeIndex = 0; routeIndex < routeMatches.length; routeIndex += 1) {
      const routeStart = routeMatches[routeIndex].index;
      const routeEnd = routeIndex + 1 < routeMatches.length
        ? routeMatches[routeIndex + 1].index
        : block.length;
      const routeBlock = block.slice(routeStart, routeEnd);
      routes.push({
        route: routeMatches[routeIndex][1],
        mode: /mode:\s*'([^']+)'/.exec(routeBlock)?.[1] ?? '',
        scenario: /scenario:\s*'([^']+)'/.exec(routeBlock)?.[1] ?? '',
        scrollers: stringArray(routeBlock, 'scrollers'),
        fixed: stringArray(routeBlock, 'fixed'),
      });
    }
    entries.push({ capability: capabilityMatches[index][1], routes });
  }
  return entries;
}

function stringArray(block, key) {
  const match = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(block);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

function quotedUnion(source, typeName, pattern = null) {
  const declaration = pattern
    ? new RegExp(pattern).exec(source)?.[1] ?? ''
    : new RegExp(`type\\s+${typeName}\\s*=([^;]+);`).exec(source)?.[1] ?? '';
  return [...declaration.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function arrayIds(source, arrayName) {
  const body = new RegExp(`${arrayName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]);
}

const GIT_SECTION_ROUTES = {
  changes: 'changes',
  history: 'history',
  branches: 'history-branches',
  worktrees: 'history-worktrees',
};
const GITHUB_SECTION_ROUTES = {
  issues: 'github-issues',
  'pull-requests': 'github-pull-requests',
  actions: 'github-actions',
};

/** Everything the current capability unions make reachable (#4222 SC-03). */
export function expectedScrollRoutes(root = ROOT) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  const claudeModel = read('web/src/capabilities/claude-code/components/claude-app/model.ts');
  const claudeKinds = [...claudeModel.matchAll(/kind:\s*'([^']+)'/g)]
    .map((match) => match[1]);
  const env = quotedUnion(
    read('web/src/capabilities/env/hooks/useEnvironmentScreen.ts'),
    'EnvironmentView',
  );
  const sandbox = read('web/src/capabilities/sandbox/components/SandboxSectionNav.tsx');
  const policies = read('web/src/capabilities/sandbox/components/SandboxPolicyTabs.tsx');
  const git = read('web/src/capabilities/git/components/GitWorkspace.tsx');
  const github = read('web/src/capabilities/git/components/GithubHostingView.tsx');
  return {
    'claude-code': claudeKinds,
    env: [...env, 'profile-editor'],
    sandbox: [
      ...arrayIds(sandbox, 'SANDBOX_SECTIONS'),
      ...arrayIds(policies, 'SANDBOX_POLICY_TABS').map((id) => `policy-${id}`),
      'enter',
    ],
    git: [
      ...quotedUnion(git, 'GitSection').map((section) => GIT_SECTION_ROUTES[section] ?? section),
      ...quotedUnion(github, 'GithubSection').map((section) => GITHUB_SECTION_ROUTES[section] ?? section),
    ],
  };
}

/**
 * The #4222 SC-03 contract, as a pure function over a coverage inventory and
 * the union-derived route map. Exported so the design source tests can prove
 * both the reject and the accept side without a repository mutation.
 */
export function checkScrollCoverageContract(entries, expectedRoutes) {
  const problems = [];
  const byCapability = new Map();
  for (const entry of entries) {
    if (byCapability.has(entry.capability)) {
      problems.push(`duplicate capability coverage: ${entry.capability}`);
    }
    byCapability.set(entry.capability, entry);
    const routes = new Set();
    for (const route of entry.routes) {
      const key = `${entry.capability}/${route.route}`;
      if (routes.has(route.route)) problems.push(`duplicate route coverage: ${key}`);
      routes.add(route.route);
      if (route.scenario.trim() === '') problems.push(`route has no executable scenario: ${key}`);
      if (route.mode === 'bounded') {
        if (route.scrollers.length === 0) problems.push(`bounded route has no scroll owner: ${key}`);
      } else if (route.mode === 'document') {
        if (route.scrollers.some((owner) => owner !== 'app-workspace-scrollport')) {
          problems.push(`document route names a non-page scroll owner: ${key}`);
        }
      } else {
        problems.push(`unknown scroll mode: ${key}`);
      }
    }
  }
  for (const [capability, expected] of Object.entries(expectedRoutes)) {
    const entry = byCapability.get(capability);
    if (!entry) {
      problems.push(`capability has no route coverage: ${capability}`);
      continue;
    }
    const routes = new Set(entry.routes.map((route) => route.route));
    for (const route of expected) {
      if (!routes.has(route)) {
        problems.push(`reachable route lacks coverage: ${capability}/${route}`);
      }
    }
    // A route removed from the capability's own union must also leave the
    // coverage; a stale owner would otherwise keep a dead endpoint "proven".
    const expectedSet = new Set(expected);
    for (const route of routes) {
      if (!expectedSet.has(route)) {
        problems.push(`coverage names a route the union no longer reaches: ${capability}/${route}`);
      }
    }
  }
  return problems;
}

function scanScrollCoverage(root = ROOT) {
  const coveragePath = join(root, SCROLL_COVERAGE_FILE);
  const entries = parseScrollCoverageSource(readFileSync(coveragePath, 'utf8'));
  const problems = checkScrollCoverageContract(entries, expectedScrollRoutes(root));
  // A declared owner that appears nowhere in shipped source is stale coverage.
  const literals = [];
  for (const path of walk(join(root, 'web', 'src'))) {
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(extname(path))) continue;
    const file = relative(root, path).replaceAll('\\', '/');
    if (isTestSource(file)) continue;
    literals.push(readFileSync(path, 'utf8'));
  }
  const source = literals.join('\n');
  for (const entry of entries) {
    for (const route of entry.routes) {
      for (const owner of [...route.scrollers, ...route.fixed]) {
        if (!source.includes(owner)) {
          problems.push(`scroll owner is not published in source: ${entry.capability}/${route.route} -> ${owner}`);
        }
      }
    }
  }
  return problems;
}

function main() {
  const violations = scanRepository(ROOT);
  const coverageProblems = scanScrollCoverage(ROOT);
  for (const problem of coverageProblems) {
    process.stderr.write(`✗ layout-ownership/scroll-coverage: ${problem}\n`);
  }
  if (violations.length > 0) {
    for (const violation of violations) process.stderr.write(`${format(violation)}\n\n`);
  }
  if (violations.length > 0 || coverageProblems.length > 0) {
    process.stderr.write(
      `✗ ${violations.length + coverageProblems.length} layout ownership violation(s)\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('✓ layout-ownership\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

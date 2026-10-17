import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// One definition of "this token value is px-measurable" for the whole design
// pipeline. A second parser here would drift from the resolver's, and the two
// would disagree about exactly the values this check exists to catch.
import { parseCssPx } from './resolve-contracts.mjs';
// #1876 Phase A: the mandatory browser subset has a single owner. Both the
// standalone profile and the coalesced Full E2E verdict read it from here.
import { browserDesignSpecPaths } from './browser-design-catalog.mjs';
import {
  emitReceipt,
  verifyReportFiles,
} from './verify-browser-design-report.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', '..');

const FAST_COMMANDS = [
  {
    id: 'token-generated-integrity',
    command: 'node design/scripts/generate-tokens.mjs --check',
    owner: 'design/tokens/* + design/scripts/generate-tokens.mjs',
    expected: 'generated token artifacts match the canonical token sources',
    repair: 'change the canonical token source, then run `just tokens-gen`',
  },
  {
    id: 'visual-vocabulary-source',
    command: 'node design/scripts/visual-vocabulary-source.mjs',
    owner: 'design/tokens/* + design/generated/lint-metadata.json + web/src/**/*.css',
    expected: 'Nession visual variables and hard visual utilities resolve through the canonical vocabulary, and consumers cannot locally suppress the gate',
    repair: 'migrate the consumer to --nession-* / a generated semantic utility / canonical recipe, or encode an explicit adapter boundary',
  },
  {
    id: 'contract-generated-integrity',
    command: 'node design/scripts/resolve-contracts.mjs --check',
    owner: 'design/contracts/* + design/scripts/resolve-contracts.mjs',
    expected: 'resolved contracts match the canonical contract sources',
    repair: 'change the canonical contract source, then run `just contracts-gen`',
  },
  {
    id: 'design-inventory-integrity',
    command: 'node design/scripts/audit-design-system.mjs --check',
    owner: 'design/scripts/audit-design-system.mjs',
    expected: 'token references and inventory classifications are internally consistent',
    repair: 'repair the referenced token/component owner instead of hiding the inventory finding',
  },
  {
    id: 'design-source-tests',
    command: 'node --test design/scripts/*.test.mjs',
    owner: 'design/scripts/*.test.mjs',
    expected: 'token, contract, contrast, inventory, and gate fixtures all pass',
    repair: 'fix the canonical design source or the failing executable contract',
  },
  {
    id: 'design-eslint-rule-fixtures',
    command: 'node --test web/eslint-plugin-nession/__tests__/*.test.js',
    owner: 'web/eslint-plugin-nession/',
    expected: 'design ESLint rules still reject their known violation fixtures',
    repair: 'fix the rule or its current-path fixture; do not weaken the rule to make the fixture green',
  },
  {
    id: 'capsule-token-boundary',
    command: './scripts/check-design-tokens.sh',
    owner: 'web/src/product/terminal/capsule/ + web/eslint-plugin-nession/',
    expected: 'capsule presentation stays on generated design vocabulary',
    repair: 'route the value through capsuleStyles and design/tokens rather than adding a local metric',
  },
];

const FULL_COMMANDS = [
  {
    id: 'web-design-eslint',
    command: 'cd web && npx eslint src --report-unused-disable-directives --max-warnings 0',
    owner: 'web/eslint.config.js + web/eslint-plugin-nession/',
    expected: 'shipping Web source satisfies visual-vocabulary, cross-experience, product-grammar and architecture rules',
    repair: 'fix the canonical owner or consumer; do not use eslint-disable as a design escape hatch',
  },
  {
    id: 'codemirror-renderer-boundary',
    command: 'cd web && npx vitest run src/platform/editor/components/__tests__/integration/CodeMirrorDesignBoundary.test.tsx --project integration',
    owner: 'web/src/platform/editor/model/editorTheme.ts',
    expected: 'Nession editor tokens reach CodeMirror\'s injected renderer styles',
    repair: 'fix the CodeMirror EditorView.theme adapter, then verify the rendered style boundary',
  },
];

// One Playwright process, one runtime. Splitting this into two invocations used
// to provision the full stack twice for the same four specs; the coalesced Full
// E2E path (#1876 Phase A) needs exactly the same selection, so the list lives
// in the catalog owner and the process is shared.
const BROWSER_COMMANDS = [
  {
    id: 'browser-design',
    command: () => 'cd e2e && npx playwright test ' + browserDesignSpecPaths().join(' '),
    owner: 'design/contracts/* + e2e/helpers/ui-assert/ + web/src/platform/editor/model/editorTheme.ts',
    expected: 'canonical browser surfaces satisfy resolved UI contracts and CodeMirror renders with workspace editor metrics',
    repair: 'fix the drifting implementation or the canonical contract owner; do not update baselines to hide a structured failure',
  },
];

export function formatViolation({ file, pattern, rule, actual, expected, owner, repair, note }) {
  return [
    'DESIGN_SYSTEM_VIOLATION',
    file ? `file: ${file}` : null,
    pattern ? `pattern: ${pattern}` : null,
    `rule: ${rule}`,
    `actual: ${actual}`,
    `expected: ${expected}`,
    `owner: ${owner}`,
    `repair: ${repair}`,
    note ? `note: ${note}` : null,
  ].filter(Boolean).join('\n');
}

export function checkSemanticTokenIdentity({ pattern, expectedToken, actualToken, resolvedPx = null }) {
  if (expectedToken === actualToken) return [];
  return [{
    pattern,
    rule: 'semantic-token-identity',
    actual: actualToken,
    expected: expectedToken,
    owner: 'design/contracts/categories/control.json',
    repair: 'use the contract-named semantic/experience band in the canonical style bridge',
    note: resolvedPx === null
      ? 'semantic identity is checked independently from resolved values'
      : `both tokens may currently resolve to ${resolvedPx}px; pixel equality does not make the semantic token correct`,
  }];
}

/**
 * The affordance a control *paints* must be smaller than the box that gets the
 * tap, and must be the token the contract names.
 *
 * The capsule's App experience is why this is a check rather than a convention.
 * `control.sm == control.md == 44px` there, so a control that grew its painting
 * back to a full 44px box is *pixel-identical* to one holding a 36px circle to
 * every measurement that reads the band — `expectTokenHeight` and
 * `expectTouchTarget` both measure the element they are handed, and both would
 * keep passing. #1034 is the change that separates the two axes; this is what
 * fails when it silently reverts.
 *
 * Numbers arrive as arguments (not read from disk) so the band can be exercised
 * directly, and "no numeric value found" is a **violation, not a skip**: a check
 * that quietly no-ops when it cannot measure is the failure mode
 * `no-capsule-magic-metrics.test.js` exists to prevent.
 */
export function checkDrawnAffordanceBand({
  pattern,
  expectedToken,
  actualToken,
  visualPx,
  bandPx,
  floorPx,
}) {
  const violations = [];

  if (actualToken !== expectedToken) {
    violations.push({
      pattern,
      rule: 'drawn-affordance-token-identity',
      actual: actualToken,
      expected: expectedToken,
      owner: 'design/contracts/patterns/terminal-capsule.json',
      repair: 'name the contract\'s visualSizeToken in the drawn-affordance class',
      note: 'the drawn affordance and the hit target are separate axes; naming the hit target here merges them back into one',
    });
  }

  const measured = typeof visualPx === 'number' && Number.isFinite(visualPx);
  if (!measured || visualPx < floorPx || visualPx >= bandPx) {
    violations.push({
      pattern,
      rule: 'drawn-affordance-band',
      actual: measured ? `${visualPx}px` : 'no numeric value found',
      expected: `${floorPx}px <= drawn affordance < ${bandPx}px (the hit target)`,
      owner: 'design/tokens/experience/*.json',
      repair: 'keep the painted affordance below the control band — a value at the band makes every secondary action read as a primary button (#1034)',
      note: 'measured, not skipped: an unreadable value is how this check would stop protecting anything',
    });
  }

  return violations;
}

const RAW_COLOR_RE = /(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\s*\()/g;
const METRIC_PREFIX = '(?:h|w|min-h|min-w|max-h|max-w|size|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|rounded|text|leading)';
const ARBITRARY_METRIC_RE = new RegExp(`\\b${METRIC_PREFIX}-\\[(?:-?\\d+(?:\\.\\d+)?)(?:px|rem|em|vh|vw|%)?\\]`, 'g');

// A design token used inside an arbitrary value is the point of an arbitrary
// value, so the check is not "no brackets" — it is "no bare literal inside the
// brackets once the tokens are accounted for".
const ARBITRARY_VALUE_RE = new RegExp(`\\b${METRIC_PREFIX}-\\[([^\\]]*)\\]`, 'g');
const TOKEN_REFERENCE_RE = /var\(--[^)]*\)/g;
const BARE_LENGTH_RE = /(?<![\w.-])-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)/;

/**
 * A literal a primitive wrote instead of naming a token.
 *
 * The first regex only sees `rounded-[7px]`, where the bracket holds nothing but
 * a number. `rounded-[min(var(--radius-md),10px)]` slips past it — the nested
 * form still *chooses* a 10px cap, and #774 asks for that to be caught.
 *
 * `calc()` is exempt, deliberately. Inside `calc()` the literal is arithmetic
 * against an already-resolved dimension — `h-[calc(100%-1px)]` compensates for a
 * border, `max-w-[calc(100%-2rem)]` insets a panel — and those are layout
 * implementation, not the primitive's design vocabulary. Replacing them with
 * tokens would be tokenising for its own sake, which #774 names as a non-goal.
 * Picking `10px` over a token is a different act: the primitive is choosing a
 * value, and that choice should have an owner.
 */
export function findNestedDesignLiterals(source) {
  const found = [];
  for (const match of source.matchAll(ARBITRARY_VALUE_RE)) {
    const value = match[1];
    if (!value || value.startsWith('calc(')) {
      continue;
    }
    const withoutTokens = value.replace(TOKEN_REFERENCE_RE, '').trim();
    // `h-[34px]` is the first rule's business. This one owns only what that
    // regex cannot see, so the two partition the space instead of reporting the
    // same class twice.
    if (/^-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)?$/.test(withoutTokens)) {
      continue;
    }
    if (BARE_LENGTH_RE.test(withoutTokens)) {
      found.push(match[0]);
    }
  }
  return found;
}

export function scanPrimitiveSource(source, file = '<fixture>') {
  const violations = [];
  for (const match of source.matchAll(RAW_COLOR_RE)) {
    violations.push({
      file,
      rule: 'no-ui-primitive-raw-color',
      actual: match[0],
      expected: 'a Semantic/Experience token-backed color',
      owner: 'design/tokens/semantic.json',
      repair: 'normalize the primitive to Nession token vocabulary before consuming it',
    });
  }
  for (const match of source.matchAll(ARBITRARY_METRIC_RE)) {
    violations.push({
      file,
      rule: 'no-ui-primitive-arbitrary-metric',
      actual: match[0],
      expected: 'an existing Semantic/Experience metric or an approved design-system extension',
      owner: 'design/tokens/experience/web.json',
      repair: 'replace the generated/raw metric with canonical vocabulary; generated shadcn code is not exempt',
    });
  }
  for (const actual of findNestedDesignLiterals(source)) {
    violations.push({
      file,
      rule: 'no-ui-primitive-nested-design-literal',
      actual,
      expected: 'a token-backed arbitrary value, e.g. min(var(--radius-md), var(--radius-lg))',
      owner: 'design/tokens/primitive.json',
      repair: 'name the token the literal stands for; a cap or floor is a design choice and needs an owner',
    });
  }
  return violations;
}

function scanUiPrimitives(root) {
  const dir = join(root, 'web/src/components/ui');
  const violations = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    violations.push(...scanPrimitiveSource(
      readFileSync(path, 'utf8'),
      relative(root, path).replaceAll('\\', '/'),
    ));
  }
  return violations;
}

function logicalControlToken(token) {
  const match = String(token).match(/(?:^|\.)control\.([A-Za-z0-9_-]+)$/);
  return match ? `control.${match[1]}` : null;
}

/**
 * `control-visual-size` → `control.visualSize`.
 *
 * The style bridge names a CSS custom property (kebab, as emitted) while the
 * contract names a token path (camel, as written). Normalizing here is what lets
 * the two be compared as the same logical token instead of as two spellings of
 * it — the same reason `logicalControlToken` reads `control.md` out of
 * `experience.web.control.md`.
 */
function logicalControlTokenFromVar(name) {
  const normalized = String(name).replace(/^nession-/, '');
  const [head, ...rest] = normalized.replace(/^control-/, '').split('-');
  return `control.${head}${rest
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}`;
}

function extractExportedString(source, exportName) {
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`export\\s+const\\s+${escaped}\\s*=\\s*(["'\\x60])([\\s\\S]*?)\\1\\s*;`);
  return source.match(re)?.[2] ?? null;
}

function checkCapsuleSemanticBridge(root) {
  const contractPath = join(root, 'design/contracts/categories/control.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const webExpected = logicalControlToken(contract.web?.heightToken);
  const appExpected = logicalControlToken(contract.app?.heightToken);
  const violations = [];

  if (!webExpected || !appExpected || webExpected !== appExpected) {
    violations.push({
      pattern: 'pattern.terminal-capsule',
      rule: 'control-contract-logical-band',
      actual: `web=${contract.web?.heightToken ?? 'missing'}, app=${contract.app?.heightToken ?? 'missing'}`,
      expected: 'Web and App category.control heightToken resolve to one logical control band',
      owner: 'design/contracts/categories/control.json',
      repair: 'make the intended semantic band explicit in the canonical contract before wiring components',
    });
    return violations;
  }

  const bridgePath = join(root, 'web/src/product/terminal/capsule/capsuleStyles.ts');
  const source = readFileSync(bridgePath, 'utf8');
  const bridge = extractExportedString(source, 'capsuleIconButtonClass');
  const actualMatch = bridge?.match(/var\(--nession-control-([A-Za-z0-9_-]+)\)/);
  const actual = actualMatch ? `control.${actualMatch[1]}` : 'missing control token';
  violations.push(...checkSemanticTokenIdentity({
    pattern: 'pattern.terminal-capsule',
    expectedToken: webExpected,
    actualToken: actual,
    resolvedPx: 44,
  }).map((violation) => ({
    ...violation,
    file: 'web/src/product/terminal/capsule/capsuleStyles.ts',
  })));

  // The drawn affordance (#1034). Both numbers are read from the token *source*
  // rather than from design/generated/*: this check runs first, before
  // `token-generated-integrity` has said whether the generated artifacts are
  // current, so a stale artifact must not be able to answer for the source.
  //
  // The band is App's `control.md` (the tap floor) and the floor is Web's
  // `control.visualSize` (32px) — Web's drawn affordance *is* its band, so a
  // value below 32px would be smaller than the platform's own smallest painted
  // control and is not a size this system has a use for.
  const capsuleContract = JSON.parse(
    readFileSync(join(root, 'design/contracts/patterns/terminal-capsule.json'), 'utf8'),
  );
  const appTokens = JSON.parse(
    readFileSync(join(root, 'design/tokens/experience/app.json'), 'utf8'),
  );
  const visualBridge = extractExportedString(source, 'capsuleIconVisualClass');
  const visualMatch = visualBridge?.match(/var\(--(nession-control-[A-Za-z0-9_-]+)\)/);
  violations.push(...checkDrawnAffordanceBand({
    pattern: 'pattern.terminal-capsule',
    expectedToken: logicalControlToken(capsuleContract.app?.visualSizeToken) ?? 'missing visualSizeToken',
    actualToken: visualMatch ? logicalControlTokenFromVar(visualMatch[1]) : 'missing control token',
    visualPx: parseCssPx(appTokens.control?.visualSize?.value),
    bandPx: 44,
    floorPx: 32,
  }).map((violation) => ({
    ...violation,
    file: 'web/src/product/terminal/capsule/capsuleStyles.ts',
  })));
  return violations;
}

function runCommand(spec, env = {}) {
  const command = typeof spec.command === 'function' ? spec.command() : spec.command;
  process.stdout.write(`\n→ [design:${spec.id}] ${command}\n`);
  const result = spawnSync('bash', ['-lc', command], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status === 0) {
    process.stdout.write(`✓ [design:${spec.id}]\n`);
    return [];
  }
  return [{
    rule: spec.id,
    actual: `command failed with exit ${result.status ?? 'unknown'}`,
    expected: spec.expected,
    owner: spec.owner,
    repair: spec.repair,
  }];
}

function browserVerdictViolation(error) {
  return {
    rule: 'browser-design-verdict',
    actual: error.message,
    expected: 'the canonical browser subset executed and passed with authenticated assertions at this exact SHA',
    owner: 'design/scripts/browser-design-catalog.mjs + e2e/runner runtime',
    repair: 'run the canonical browser profile; a missing, skipped, flaky, zero-assertion or foreign-SHA report is not a Pass',
  };
}

function verifyBrowserReport({ reportFile, assertionsFile, sha }) {
  try {
    return {
      result: verifyReportFiles({
        reportFile,
        assertionsFile,
        sha,
        root: ROOT,
      }),
    };
  } catch (error) {
    return { violation: browserVerdictViolation(error) };
  }
}

function writeBrowserReceipt(result, filename = process.env.DESIGN_BROWSER_RECEIPT_FILE) {
  const line = emitReceipt(result);
  process.stdout.write(line);
  if (!filename) return;
  if (!filename.startsWith('/')) {
    throw new Error('DESIGN_BROWSER_RECEIPT_FILE must be absolute');
  }
  writeFileSync(filename, line);
}

function runBrowserProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'nession-design-browser-'));
  // A caller may ask for the raw evidence (the workflow proves fail-closed
  // behavior against the SAME report the standalone verdict used). Explicit
  // *_OUT paths are caller-owned and survive this run; temp paths do not.
  const reportOut = process.env.DESIGN_BROWSER_REPORT_OUT;
  const assertionsOut = process.env.DESIGN_BROWSER_ASSERTIONS_OUT;
  const reportFile = reportOut || join(dir, 'playwright.json');
  const assertionsFile = assertionsOut || join(dir, 'assertions.json');
  const reporter = join(ROOT, 'scripts', 'issue-e2e-assertion-reporter.cjs');
  try {
    const [spec] = BROWSER_COMMANDS;
    const command = typeof spec.command === 'function' ? spec.command() : spec.command;
    const violations = runCommand({
      ...spec,
      // The built-in JSON report alone cannot prove attempts executed
      // assertions; the trusted reporter counts expect() steps per result.
      command: `${command} --reporter=json,${reporter},html`,
    }, {
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
      NESSION_E2E_ASSERTIONS_OUTPUT_FILE: assertionsFile,
    });
    if (violations.length > 0) return violations;
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
      .stdout.trim();
    const { result, violation } = verifyBrowserReport({ reportFile, assertionsFile, sha });
    if (violation) return [violation];
    writeBrowserReceipt(result);
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? '' : argv[index + 1] ?? '';
}

function verifyReportMode(argv) {
  const reportFile = argValue(argv, '--verify-report');
  const assertionsFile = argValue(argv, '--assertions');
  const sha = argValue(argv, '--sha');
  const receipt = argValue(argv, '--receipt');
  if (!assertionsFile) {
    process.stderr.write('DESIGN_SYSTEM_VIOLATION\nrule: browser-design-verdict\n' +
      'actual: --assertions is required with --verify-report\n\n');
    return 1;
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    process.stderr.write('DESIGN_SYSTEM_VIOLATION\nrule: browser-design-verdict\n' +
      'actual: --sha must be the exact 40-character target SHA\n\n');
    return 1;
  }
  const { result, violation } = verifyBrowserReport({ reportFile, assertionsFile, sha });
  if (violation) {
    process.stderr.write('\n' + formatViolation(violation) + '\n\n');
    return 1;
  }
  writeBrowserReceipt(result, receipt);
  return 0;
}

function profileCommands(profile) {
  if (profile === 'fast') return FAST_COMMANDS;
  if (profile === 'full') return [...FAST_COMMANDS, ...FULL_COMMANDS];
  if (profile === 'browser') return BROWSER_COMMANDS;
  throw new Error(`Unknown design gate profile: ${profile}. Expected fast, full, or browser.`);
}

export function parseProfile(argv) {
  const index = argv.indexOf('--profile');
  return index === -1 ? 'full' : argv[index + 1] ?? 'full';
}

function main() {
  const argv = process.argv.slice(2);
  const profile = parseProfile(argv);
  const violations = [];

  if (profile === 'browser' && argv.includes('--verify-report')) {
    process.exitCode = verifyReportMode(argv);
    return;
  }

  if (profile !== 'browser') {
    violations.push(...scanUiPrimitives(ROOT));
    violations.push(...checkCapsuleSemanticBridge(ROOT));
  }

  if (violations.length === 0) {
    if (profile === 'browser') {
      violations.push(...runBrowserProfile());
    } else {
      for (const spec of profileCommands(profile)) {
        violations.push(...runCommand(spec));
        if (violations.length > 0) break;
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write('\n');
    for (const violation of violations) {
      process.stderr.write(`${formatViolation(violation)}\n\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n✓ design-check (${profile}) passed\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

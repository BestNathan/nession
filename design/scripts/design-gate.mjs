import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
    owner: 'web/src/features/terminal/capsule/ + web/eslint-plugin-nession/',
    expected: 'capsule presentation stays on generated design vocabulary',
    repair: 'route the value through capsuleStyles and design/tokens rather than adding a local metric',
  },
];

const FULL_COMMANDS = [
  {
    id: 'web-design-eslint',
    command: 'cd web && npx eslint src --report-unused-disable-directives --max-warnings 0',
    owner: 'web/eslint.config.js + web/eslint-plugin-nession/',
    expected: 'shipping Web source satisfies primitive/cross-experience/magic-metric design rules',
    repair: 'fix the canonical owner or consumer; do not use eslint-disable as a design escape hatch',
  },
  {
    id: 'codemirror-renderer-boundary',
    command: 'cd web && npx vitest run src/features/files/components/__tests__/integration/CodeMirrorDesignBoundary.test.tsx --project integration',
    owner: 'web/src/features/files/model/editorTheme.ts',
    expected: 'Nession editor tokens reach CodeMirror\'s injected renderer styles',
    repair: 'fix the CodeMirror EditorView.theme adapter, then verify the rendered style boundary',
  },
];

const BROWSER_COMMANDS = [
  {
    id: 'browser-ui-contracts',
    command: 'cd e2e && npx playwright test specs/ui-contract-assertions.spec.ts specs/ui-contract-matrix.spec.ts',
    owner: 'design/contracts/* + e2e/helpers/ui-assert/',
    expected: 'canonical browser surfaces satisfy resolved UI contracts across the viewport matrix',
    repair: 'fix the drifting implementation or the canonical contract owner; do not update baselines to hide a structured failure',
  },
  {
    // The full profile's `codemirror-renderer-boundary` proves the token reached
    // CodeMirror's injected stylesheet. That is not the same claim as the token
    // reaching the *rendered result*: a stylesheet can name a custom property
    // that resolves to nothing, or match no element, or lose to a later rule,
    // and the injected CSS still reads as correct. #757 was exactly that — the
    // source looked right and the cascade decided otherwise. This entry
    // measures computed styles on the running editor, which is the claim SC9
    // actually makes.
    id: 'codemirror-rendered-metrics',
    command: 'cd e2e && npx playwright test specs/design-renderer-boundary.spec.ts',
    owner: 'web/src/features/files/model/editorTheme.ts',
    expected: "CodeMirror's rendered metrics match the workspace editor tokens rather than its own defaults",
    repair: "the token did not reach the rendered result — move the decision into EditorView.theme; a utility class loses to CodeMirror's injected theme",
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

  const bridgePath = join(root, 'web/src/features/terminal/capsule/capsuleStyles.ts');
  const source = readFileSync(bridgePath, 'utf8');
  const bridge = extractExportedString(source, 'capsuleIconButtonClass');
  const actualMatch = bridge?.match(/var\(--control-([A-Za-z0-9_-]+)\)/);
  const actual = actualMatch ? `control.${actualMatch[1]}` : 'missing control token';
  violations.push(...checkSemanticTokenIdentity({
    pattern: 'pattern.terminal-capsule',
    expectedToken: webExpected,
    actualToken: actual,
    resolvedPx: 44,
  }).map((violation) => ({
    ...violation,
    file: 'web/src/features/terminal/capsule/capsuleStyles.ts',
  })));
  return violations;
}

function runCommand(spec) {
  process.stdout.write(`\n→ [design:${spec.id}] ${spec.command}\n`);
  const result = spawnSync('bash', ['-lc', spec.command], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
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
  const profile = parseProfile(process.argv.slice(2));
  const violations = [];

  if (profile !== 'browser') {
    violations.push(...scanUiPrimitives(ROOT));
    violations.push(...checkCapsuleSemanticBridge(ROOT));
  }

  if (violations.length === 0) {
    for (const spec of profileCommands(profile)) {
      violations.push(...runCommand(spec));
      if (violations.length > 0) break;
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

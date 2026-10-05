import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..', '..');
const WEB_SRC = join(ROOT, 'web', 'src');
const METADATA = JSON.parse(
  readFileSync(join(ROOT, 'design', 'generated', 'lint-metadata.json'), 'utf8'),
);

const FRAMEWORK_VAR_PREFIXES = [
  'font-',
  'color-',
  'spacing-',
  'radius-',
  'tw-',
  'animate-',
];

function sets(metadata = METADATA) {
  return {
    canonical: new Set((metadata.cssVariables ?? []).map((v) => v.replace(/^--/, ''))),
    legacy: new Set((metadata.legacyCssVariables ?? []).map((v) => v.replace(/^--/, ''))),
  };
}

function frameworkVariable(name) {
  return FRAMEWORK_VAR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

export function scanCssSource(source, file = '<fixture>', metadata = METADATA) {
  const { canonical, legacy } = sets(metadata);
  const violations = [];
  const seen = new Set();

  for (const match of source.matchAll(/--([A-Za-z0-9_-]+)\s*:/g)) {
    const name = match[1];
    const key = `definition:${match.index}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (
      canonical.has(name) ||
      name.startsWith('nession-local-') ||
      frameworkVariable(name)
    ) {
      continue;
    }

    violations.push({
      file,
      line: lineNumber(source, match.index),
      kind: legacy.has(name) ? 'legacy-definition' : 'foreign-definition',
      actual: `--${name}`,
      repair: legacy.has(name)
        ? `define/consume --nession-${name} through the token generator`
        : `rename a genuinely local property to --nession-local-${name}, or move a third-party variable behind an approved adapter`,
    });
  }

  for (const match of source.matchAll(/var\(--([A-Za-z0-9_-]+)/g)) {
    const name = match[1];
    const key = `reference:${match.index}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (
      canonical.has(name) ||
      name.startsWith('nession-local-') ||
      frameworkVariable(name)
    ) {
      continue;
    }

    violations.push({
      file,
      line: lineNumber(source, match.index),
      kind: legacy.has(name) ? 'legacy-reference' : 'foreign-reference',
      actual: `var(--${name})`,
      repair: legacy.has(name)
        ? `use var(--nession-${name})`
        : `route this value through --nession-* or an approved framework/renderer adapter`,
    });
  }

  return violations;
}

export function scanVisualVocabularySuppression(source, file = '<fixture>') {
  const violations = [];
  for (const match of source.matchAll(/eslint-disable(?:-next-line|-line)?[^\n]*nession\/visual-vocabulary/g)) {
    violations.push({
      file,
      line: lineNumber(source, match.index),
      kind: 'local-suppression',
      actual: match[0],
      repair:
        'fix the canonical visual owner; if an integration needs an exception, encode it in the adapter boundary rather than disabling the consumer rule',
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
    const ext = extname(path);
    if (!['.css', '.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
    const rel = relative(root, path).replaceAll('\\', '/');
    const source = readFileSync(path, 'utf8');
    if (ext === '.css') violations.push(...scanCssSource(source, rel));
    if (ext !== '.css') violations.push(...scanVisualVocabularySuppression(source, rel));
  }
  return violations;
}

function format(v) {
  return [
    'DESIGN_SYSTEM_VIOLATION',
    `file: ${v.file}`,
    `line: ${v.line}`,
    'rule: visual-vocabulary-source',
    `kind: ${v.kind}`,
    `actual: ${v.actual}`,
    'expected: generated --nession-* vocabulary or an explicit canonical adapter',
    'owner: design/tokens/* + design/scripts/generate-tokens.mjs',
    `repair: ${v.repair}`,
  ].join('\n');
}

function main() {
  const violations = scanRepository(ROOT);
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(`${format(violation)}\n\n`);
    }
    process.stderr.write(`✗ ${violations.length} visual vocabulary source violation(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('✓ visual-vocabulary-source\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

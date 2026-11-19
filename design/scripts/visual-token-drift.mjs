import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, '..', 'contracts', 'visual-token-debt.json');
// Pinned Git blob of the approved pre-migration inventory. A PR cannot silently
// grow the allowance by editing JSON; the canonical Gate itself must be
// consciously revised and reviewed, with explicit migration rationale.
export const PINNED_LEGACY_BASELINE_BLOB = '51de139b34944136eba1998c5ef47b2b0011d698';

/** One lexical collector for both ESLint and the fast source Gate. Legacy
 * literal baseline decisions are based on the complete Git blob, not the
 * position or the particular authoring frontend.
 */
function maskStyleComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (match, prefix) =>
      prefix + ' '.repeat(match.length - prefix.length));
}

function sourceStringLiterals(source) {
  const values = [];
  const patterns = [
    /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
    /"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /`([^`\\]*(?:\\.[^`\\]*)*)`/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      values.push({value: match[1], index: match.index ?? 0});
    }
  }
  return values;
}

export function collectNonTokenSourceMetrics(source, file) {
  if (!isShippingStyleFile(file)) return [];
  const normalized = normalizeStyleFile(file);
  if (normalized.endsWith('src/platform/editor/model/editorTheme.ts') ||
      normalized.endsWith('src/shared/markdown/markdownVisualGrammar.ts')) {
    return []; // Renderer-specific adapter with its own design contract.
  }
  const masked = maskStyleComments(source);
  if (normalized.endsWith('.css')) return findNonTokenCssMetrics(masked);

  const observations = [];
  for (const literal of sourceStringLiterals(masked)) {
    for (const metric of findNonTokenMetricUtilities(literal.value)) {
      observations.push({...metric, literal: literal.value, index: literal.index});
    }
  }
  observations.push(...findNonTokenInlineMetrics(masked));
  return observations;
}

export function gitBlobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * A ratcheted inventory of *old* non-token visual metrics. Never regenerate
 * this baseline from PR-head code: that would make every new violation legal.
 * A scoped reviewer can explicitly shrink the inventory after migration.
 */
export function readLegacyMetricBaseline() {
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  if (gitBlobSha(raw) !== PINNED_LEGACY_BASELINE_BLOB) {
    throw new Error('non-token visual baseline changed without Design Gate owner approval');
  }
  const manifest = JSON.parse(raw);
  if (manifest.schema_version !== 1 || !manifest.files) throw new Error('invalid visual baseline');
  return manifest;
}

export function normalizeStyleFile(filename) {
  const name = String(filename ?? '').replaceAll('\\', '/');
  const index = name.lastIndexOf('/web/src/');
  if (index !== -1) return name.slice(index + 1);
  return name.startsWith('web/src/') ? name : name;
}

export function isShippingStyleFile(filename) {
  const name = normalizeStyleFile(filename);
  return name.startsWith('web/src/') &&
    /\.(?:tsx?|jsx?|css)$/.test(name) &&
    !name.startsWith('web/src/generated/') &&
    !name.startsWith('web/src/test/') &&
    !name.includes('/__tests__/') &&
    !/\.(?:test|spec)\.[^.]+$/.test(name);
}

const METRIC_CLASS_RE =
  /^-?(?:gap(?:-[xy])?|space-[xy]|p[trblxy]?|m[trblxy]?|w|h|size|min-[wh]|max-[wh]|top|right|bottom|left|inset(?:-[xy])?)-(.+)$/;
const NON_METRIC_SUFFIX = /^(?:0|auto|full|screen|svh|dvh|lvh|svw|dvw|lvw|min|max|fit|none|px-0|\d+\/\d+)$/;
const RAW_LENGTH = /(?:^|[^\w.-])-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|dvh|svh|ch|%)\b/;

function bareClass(raw) {
  // Tailwind variant syntax; split only outside arbitrary [..] brackets.
  let depth = 0, i = 0;
  for (let j = 0; j < raw.length; j += 1) {
    if (raw[j] === '[') depth++;
    else if (raw[j] === ']') depth--;
    else if (raw[j] === ':' && depth === 0) i = j + 1;
  }
  return raw.slice(i).replace(/^!/, '');
}

export function findNonTokenMetricUtilities(value) {
  if (typeof value !== 'string') return [];
  const violations = [];
  for (const candidate of value.split(/\s+/).filter(Boolean)) {
    const token = bareClass(candidate);
    const match = token.match(METRIC_CLASS_RE);
    if (!match) continue;
    const suffix = match[1];
    if (NON_METRIC_SUFFIX.test(suffix)) continue;
    if (/^-?\d+(?:\.\d+)?$/.test(suffix) && Number(suffix) !== 0) {
      violations.push({token: candidate, kind: 'raw-metric'});
      continue;
    }
    if (suffix === 'px') {
      violations.push({token: candidate, kind: 'raw-metric'});
      continue;
    }
    const arbitrary = suffix.match(/^\[(.+)\]$/s);
    if (!arbitrary) continue;
    const expression = arbitrary[1];
    if (expression.includes('var(--nession-') && !RAW_LENGTH.test(expression.replace(/var\([^)]*\)/g, ''))) continue;
    // CSS variable shorthand is handled by the existing generated-vocabulary
    // rule and need not be reinterpreted as a literal number.
    if (expression.startsWith('--nession-')) continue;
    if (RAW_LENGTH.test(expression) || /^-?\d+(?:\.\d+)?$/.test(expression)) {
      violations.push({token: candidate, kind: 'raw-metric'});
    }
  }
  return violations;
}

const CSS_METRIC_DECLARATION =
  /(?:^|[;{\n])\s*((?:padding|margin)(?:-(?:top|right|bottom|left|inline|block))?|(?:row-|column-)?gap|(?:min-|max-)?(?:width|height)|font-size|border-radius|top|right|bottom|left)\s*:\s*([^;{}\n]+)/gm;
const JSX_METRIC_PROPERTY =
  /\b((?:padding|margin)(?:Top|Bottom|Left|Right|Inline|Block)?|(?:row|column)?Gap|(?:min|max)?(?:Width|Height)|fontSize|borderRadius)\s*:\s*['"]?(-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)?)/g;

export function findNonTokenCssMetrics(source) {
  const out = [];
  for (const hit of source.matchAll(CSS_METRIC_DECLARATION)) {
    const value = hit[2].trim();
    if (value === '0' || value === '0px' || value === 'auto' || value === 'none' ||
        value === 'inherit' || value === 'initial' || value === 'unset' || value === '100%') continue;
    const withoutTokens = value.replace(/var\([^)]*\)/g, '');
    if (!RAW_LENGTH.test(withoutTokens)) continue;
    out.push({token: hit[1] + ': ' + value, kind:'raw-css-metric', literal:hit[0], index:hit.index ?? 0});
  }
  return out;
}

export function findNonTokenInlineMetrics(source) {
  const out = [];
  for (const hit of source.matchAll(JSX_METRIC_PROPERTY)) {
    const value = hit[2].trim();
    if (Number(value) === 0) continue;
    out.push({token: hit[1] + ': ' + value, kind:'raw-inline-metric', literal:hit[0], index:hit.index ?? 0});
  }
  return out;
}

/** Entire original source blobs are immutable debt exceptions, not a mutable
 * per-class allowlist. Any edit to a file containing non-token metrics must
 * actually migrate those metrics; copying a legacy class can never hide.
 */
export function rejectNewMetricDebt(file, source, observations, baseline = readLegacyMetricBaseline()) {
  if (!observations.length) return [];
  const normalized = normalizeStyleFile(file);
  const allowed = baseline.files?.[normalized] ?? [];
  return allowed.includes(gitBlobSha(source)) ? [] : observations;
}

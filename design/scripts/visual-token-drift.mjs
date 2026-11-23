import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, '..', 'contracts', 'visual-token-debt.json');
// Pinned Git blob of the approved pre-migration inventory. A PR cannot silently
// grow the allowance by editing JSON; the canonical Gate itself must be
// consciously revised and reviewed, with explicit migration rationale.
// #4221 convergence reconciliation (explicit Design Gate baseline approval):
// folded staging@a19633cf1's 43 pre-existing legacy blobs into the inventory so
// main's debt enforcement recognizes staging's existing debt. This grandfathers
// existing legacy only; any new/edited raw metric still fails the gate.
//
// #4222 scroll-ownership reconciliation (explicit Design Gate baseline
// approval): the App Workspace scroll-port migration edits 35 legacy files at
// their scroll-root/marker seams, which unfreezes the whole-file debt those
// files already carried. Re-freezing those exact blobs preserves the invariant
// this inventory protects — no new visual metric is admitted (the #4222 diff
// introduces none) — while keeping a 623-metric, unrelated token migration out
// of a scroll-ownership change. Any further edit to one of these files still
// changes its blob and fails closed until its metrics are migrated.
export const PINNED_LEGACY_BASELINE_BLOB = 'd0bae9f500121096b6b9026a0fd6f55f1598feec';

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
  for (const localVar of masked.matchAll(UNOWNED_LOCAL_VISUAL_VAR)) {
    observations.push({token: localVar[0], kind: 'unowned-local-variable',
      literal: localVar[0], index: localVar.index ?? 0});
  }
  for (const literal of sourceStringLiterals(masked)) {
    for (const metric of findNonTokenMetricUtilities(literal.value)) {
      observations.push({...metric, literal: literal.value, index: literal.index});
    }
    for (const dynamic of literal.value.matchAll(DYNAMIC_VISUAL_CLASS_RE)) {
      observations.push({token: dynamic[1], kind: 'dynamic-visual-class',
        literal: literal.value, index: literal.index});
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
let frozenBaseline = null;
export function readLegacyMetricBaseline() {
  if (frozenBaseline) return frozenBaseline;
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  if (gitBlobSha(raw) !== PINNED_LEGACY_BASELINE_BLOB) {
    throw new Error('non-token visual baseline changed without Design Gate owner approval');
  }
  const manifest = JSON.parse(raw);
  if (manifest.schema_version !== 1 || !manifest.files) throw new Error('invalid visual baseline');
  frozenBaseline = manifest;
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

// A local CSS variable or interpolated Tailwind metric is not a generated
// design token. Both would silently bypass value-level checks otherwise.
const UNOWNED_LOCAL_VISUAL_VAR = /--nession-local-[a-zA-Z0-9_-]+/g;
const DYNAMIC_VISUAL_CLASS_RE =
  /(?:^|\s)(-?(?:gap(?:-[xy])?|space-[xy]|p[trblxy]?|m[trblxy]?|w|h|size|min-[wh]|max-[wh]|top|right|bottom|left|inset(?:-[xy])?)-\$\{)/g;
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
const CSS_RAW_VISUAL_DECLARATION =
  /(?:^|[;{\n])\s*(color|background(?:-color)?|border(?:-color|-width)?|outline(?:-color|-width)?|box-shadow|text-shadow|fill|stroke|font-weight|opacity)\s*:\s*([^;{}\n]+)/gm;
const CSS_LITERAL_COLOR = /(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\s*\()/;
const JSX_METRIC_PROPERTY =
  /\b((?:padding|margin)(?:Top|Bottom|Left|Right|Inline|Block)?|(?:row|column)?Gap|(?:min|max)?(?:Width|Height)|width|height|top|right|bottom|left|inset|fontSize|borderRadius)\s*:\s*['"]?(-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)?)/g;

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
  for (const hit of source.matchAll(CSS_RAW_VISUAL_DECLARATION)) {
    const value = hit[2].trim();
    const withoutTokens = value.replace(/var\([^)]*\)/g, '');
    const isColorOrShadow = CSS_LITERAL_COLOR.test(withoutTokens) ||
      (/(?:shadow|border|outline)/.test(hit[1]) && RAW_LENGTH.test(withoutTokens));
    const numericVisual = /^(?:opacity|font-weight)$/.test(hit[1]) &&
      /^-?\d+(?:\.\d+)?$/.test(value) && Number(value) !== 0 && Number(value) !== 1;
    if (!isColorOrShadow && !numericVisual) continue;
    out.push({token: hit[1] + ': ' + value, kind:'raw-css-visual', literal:hit[0], index:hit.index ?? 0});
  }
  return out;
}

export function findNonTokenInlineMetrics(source) {
  const out = [];
  for (const hit of source.matchAll(JSX_METRIC_PROPERTY)) {
    const before = source.slice(Math.max(0, (hit.index ?? 0) - 240), hit.index);
    // These are CSS/JSX style objects, not arbitrary business objects with a
    // numerical "width" or "height" field.
    if (!/(?:\bstyle\s*=\s*\{\{|\bstyle\s*:\s*\{|\b(?:style|styles)\s*=\s*\{|\bCSSProperties\s*=\s*\{)[^{}]*$/s.test(before)) continue;
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

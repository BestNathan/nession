import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, '..', 'contracts', 'visual-token-debt.json');

/**
 * A ratcheted inventory of *old* non-token visual metrics. Never regenerate
 * this baseline from PR-head code: that would make every new violation legal.
 * A scoped reviewer can explicitly shrink the inventory after migration.
 */
export function readLegacyMetricBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
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

export function metricDebtFingerprint(literal, token) {
  return createHash('sha256').update(literal + '\0' + token).digest('hex').slice(0, 24);
}

/** A count cap means copying an existing legacy literal cannot evade the Gate. */
export function rejectNewMetricDebt(file, observations, baseline = readLegacyMetricBaseline()) {
  const normalized = normalizeStyleFile(file);
  const allowed = baseline.entries?.[normalized] ?? {};
  const seen = new Map();
  return observations.filter(item => {
    const key = metricDebtFingerprint(item.literal, item.token);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count > (allowed[key] ?? 0);
  });
}

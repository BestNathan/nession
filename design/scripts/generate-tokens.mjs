import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESIGN_DIR = join(SCRIPT_DIR, '..');
const TOKENS_DIR = join(DESIGN_DIR, 'tokens');
const GENERATED_DIR = join(DESIGN_DIR, 'generated');

const NON_COLOR_SEMANTIC = new Set(['radius', 'radius-capsule']);

const THEME_SIZE_PREFIXES = [
  'control-',
  'row-',
  'composer-',
  'shell-space-',
  'shell-icon-button-size',
  'focus-ring-',
  'terminal-well-background',
  'terminal-capsule-surface',
  'radius-capsule',
  'motion-composer',
  'motion-shell-',
  'touch-target-min',
];

const LINT_PRIMITIVES = {
  'green-500': ['success', 'agent-online'],
  'green-400': ['success', 'agent-online'],
  'emerald-500': ['success', 'session-active'],
  'amber-500': ['warning', 'file-modified'],
  'amber-400': ['warning'],
  'amber-600': ['warning'],
  'yellow-600': ['warning'],
  'red-500': ['destructive', 'danger', 'agent-error', 'file-deleted'],
  'red-400': ['destructive', 'danger'],
  'red-600': ['destructive'],
  'blue-500': ['info'],
  'blue-400': ['info'],
  'blue-300': ['info'],
  'blue-800': ['info'],
  'blue-700': ['info'],
  'blue-100': ['info'],
  'blue-200': ['info'],
  'gray-400': ['muted-foreground', 'session-unknown'],
  'gray-500': ['muted-foreground'],
  black: ['overlay', 'inverse'],
  white: ['primary-foreground'],
};

const EXPERIENCE_APP_CLASSES = [
  'touch-target-min',
  'control-app-sm',
  'control-app-md',
  'control-app-lg',
];

function isLeaf(node) {
  return Boolean(node) && typeof node === 'object' && ('ref' in node || 'value' in node);
}

function getPath(obj, path) {
  let current = obj;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function flattenLeaves(obj, prefix = []) {
  const leaves = [];
  if (isLeaf(obj)) {
    if (prefix.length > 0) leaves.push({ path: prefix, node: obj });
    return leaves;
  }
  if (!obj || typeof obj !== 'object') return leaves;
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;
    leaves.push(...flattenLeaves(value, [...prefix, key]));
  }
  return leaves;
}

function toKebab(parts) {
  return parts
    .map((part) => String(part).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
    .join('-');
}

export function resolveRef(node, tokens, seen = new Set(), theme = 'light') {
  if (node == null || typeof node !== 'object') {
    throw new Error('invalid token node');
  }
  if ('value' in node) {
    return { value: node.value };
  }
  if (!('ref' in node) || typeof node.ref !== 'string') {
    throw new Error('token node missing ref/value');
  }
  const ref = node.ref;
  if (seen.has(ref)) {
    throw new Error(`circular ref: ${ref}`);
  }
  seen.add(ref);

  let target = getPath(tokens, ref);
  if (
    target === undefined &&
    ref.startsWith('semantic.') &&
    !ref.startsWith('semantic.themes.')
  ) {
    const name = ref.slice('semantic.'.length);
    target = getPath(tokens, `semantic.themes.${theme}.${name}`);
  }
  if (target === undefined || (target && typeof target === 'object' && !isLeaf(target))) {
    throw new Error(`missing ref: ${ref}`);
  }
  return resolveRef(target, tokens, seen, theme);
}

function cssVarFromRef(ref) {
  if (ref.startsWith('semantic.themes.')) {
    return `var(--${ref.split('.').slice(3).join('-')})`;
  }
  if (ref.startsWith('semantic.')) {
    return `var(--${ref.slice('semantic.'.length).replace(/\./g, '-')})`;
  }
  if (ref.startsWith('domain.')) {
    return `var(--${toKebab(ref.slice('domain.'.length).split('.'))})`;
  }
  return null;
}

function cssValue(node, tokens, theme = 'light') {
  if ('value' in node) {
    return String(node.value);
  }
  const asVar = cssVarFromRef(node.ref);
  if (asVar) return asVar;
  return String(resolveRef(node, tokens, new Set(), theme).value);
}

function emitCustomProps(leaves, tokens, theme) {
  return leaves.map(
    ({ path, node }) => `  --${toKebab(path)}: ${cssValue(node, tokens, theme)};`,
  );
}

function shouldBridgeThemeSize(name) {
  return THEME_SIZE_PREFIXES.some(
    (prefix) => name === prefix || name.startsWith(prefix),
  );
}

function emitAppExperienceRemap(tokens) {
  const app = tokens.experience?.app ?? {};
  const appLeaves = flattenLeaves(app);
  if (appLeaves.length === 0) {
    return [];
  }
  const lines = appLeaves.map(
    ({ path, node }) => `  --${toKebab(path)}: ${cssValue(node, tokens, 'light')};`,
  );
  return ['', '[data-experience="app"] {', ...lines, '}', ''];
}

export function generateWebCss(tokens) {
  const light = tokens.semantic?.themes?.light ?? {};
  const dark = tokens.semantic?.themes?.dark ?? {};
  const domain = tokens.domain ?? {};
  const web = tokens.experience?.web ?? {};

  const lightSemantic = flattenLeaves(light);
  const darkSemantic = flattenLeaves(dark);
  const domainLeaves = flattenLeaves(domain);
  const webLeaves = flattenLeaves(web);

  const root = [
    ...emitCustomProps(lightSemantic, tokens, 'light'),
    ...emitCustomProps(domainLeaves, tokens, 'light'),
    ...emitCustomProps(webLeaves, tokens, 'light'),
  ];
  const darkBlock = [
    ...emitCustomProps(darkSemantic, tokens, 'dark'),
    ...emitCustomProps(domainLeaves, tokens, 'dark'),
  ];

  const themeBridges = [];
  for (const { path } of lightSemantic) {
    const name = toKebab(path);
    if (NON_COLOR_SEMANTIC.has(name)) continue;
    themeBridges.push(`  --color-${name}: var(--${name});`);
  }
  for (const { path } of domainLeaves) {
    const name = toKebab(path);
    themeBridges.push(`  --color-${name}: var(--${name});`);
  }
  for (const { path } of webLeaves) {
    const name = toKebab(path);
    if (shouldBridgeThemeSize(name)) {
      themeBridges.push(`  --spacing-${name}: var(--${name});`);
    }
  }
  for (const { path } of lightSemantic) {
    const name = toKebab(path);
    if (shouldBridgeThemeSize(name)) {
      themeBridges.push(`  --spacing-${name}: var(--${name});`);
    }
  }

  return [
    '/* generated — do not edit */',
    '',
    ':root {',
    ...root,
    '}',
    '',
    '.dark {',
    ...darkBlock,
    '}',
    '',
    '@theme inline {',
    ...themeBridges,
    '}',
    ...emitAppExperienceRemap(tokens),
  ].join('\n');
}

export function generateLintMetadata(_tokens) {
  const meta = {};
  for (const [id, suggestions] of Object.entries(LINT_PRIMITIVES)) {
    meta[id] = {
      layer: 'primitive',
      allowedInComponent: false,
      suggestions: [...suggestions],
    };
  }
  meta.experienceAppClasses = [...EXPERIENCE_APP_CLASSES];
  return meta;
}

function parseExperienceValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
    if (match) return Number(match[1]);
  }
  return value;
}

function unwrapExperience(node, tokens) {
  if (isLeaf(node)) {
    const raw = 'value' in node ? node.value : resolveRef(node, tokens).value;
    return parseExperienceValue(raw);
  }
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    out[key] = unwrapExperience(value, tokens);
  }
  return out;
}

function jsLiteral(value, indent = 0) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value && typeof value === 'object') {
    const inner = '  '.repeat(indent + 1);
    const close = '  '.repeat(indent);
    const entries = Object.entries(value).map(
      ([key, child]) => `${inner}${key}: ${jsLiteral(child, indent + 1)}`,
    );
    return `{\n${entries.join(',\n')},\n${close}}`;
  }
  return JSON.stringify(value);
}

export function generateAppTs(tokens) {
  const app = unwrapExperience(tokens.experience?.app ?? {}, tokens);
  const lines = ['// generated — do not edit', ''];
  for (const [key, value] of Object.entries(app)) {
    lines.push(`export const ${key} = ${jsLiteral(value)} as const;`);
  }
  lines.push('');
  return lines.join('\n');
}

function readJson(relativePath) {
  const path = join(TOKENS_DIR, relativePath);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `failed to read ${path}: ${err.message}\n  Fix: add the token JSON under design/tokens/`,
    );
  }
}

export function loadTokens() {
  return {
    primitive: readJson('primitive.json'),
    semantic: readJson('semantic.json'),
    domain: readJson('domain.json'),
    experience: {
      web: readJson('experience/web.json'),
      app: readJson('experience/app.json'),
    },
  };
}

function artifactsFrom(tokens) {
  return {
    'web.css': generateWebCss(tokens),
    'lint-metadata.json': `${JSON.stringify(generateLintMetadata(tokens), null, 2)}\n`,
    'app.ts': generateAppTs(tokens),
  };
}

function writeArtifacts(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

function checkArtifacts(files) {
  const temp = mkdtempSync(join(tmpdir(), 'nession-tokens-'));
  writeArtifacts(temp, files);
  let failed = false;
  for (const name of Object.keys(files)) {
    const expectedPath = join(temp, name);
    const actualPath = join(GENERATED_DIR, name);
    const expected = readFileSync(expectedPath, 'utf8');
    let actual;
    try {
      actual = readFileSync(actualPath, 'utf8');
    } catch {
      console.error(`✗ ${join('design/generated', name)} is missing`);
      console.error('  Fix: node design/scripts/generate-tokens.mjs');
      failed = true;
      continue;
    }
    if (actual !== expected) {
      console.error(`✗ ${join('design/generated', name)} is out of date`);
      console.error('  Fix: node design/scripts/generate-tokens.mjs');
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

function runningAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

function main() {
  const tokens = loadTokens();
  const files = artifactsFrom(tokens);
  if (process.argv.includes('--check')) {
    checkArtifacts(files);
    return;
  }
  writeArtifacts(GENERATED_DIR, files);
}

if (runningAsCli()) {
  main();
}

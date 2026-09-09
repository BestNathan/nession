import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTokens, resolveRef } from './generate-tokens.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESIGN_DIR = join(SCRIPT_DIR, '..');
const CONTRACTS_DIR = join(DESIGN_DIR, 'contracts');
const GENERATED_DIR = join(DESIGN_DIR, 'generated');
const GENERATED_FILE = join(GENERATED_DIR, 'contracts.json');
const REPO_ROOT = join(DESIGN_DIR, '..');

// Per-experience constraint vocabulary — keep in sync with schema.json $defs.
const BLOCK_FIELDS = {
  wrap: 'boolean',
  heightToken: 'token',
  minHeightToken: 'token',
  overflow: 'enum:clip,menu,sheet,scroll,wrap',
  alignY: 'enum:top,middle,bottom',
  justify: 'enum:start,center,end,space-between,space-around',
  minWidthToken: 'token',
  maxWidthToken: 'token',
  scrollOwner: 'scrollOwner',
  touchTargetToken: 'token',
  visibility: 'visibility',
};

const TOKEN_TARGET_FIELDS = new Set([
  'heightToken',
  'minHeightToken',
  'touchTargetToken',
  'minWidthToken',
  'maxWidthToken',
]);

// ── Token index ─────────────────────────────────────────────────────────────

function isLeaf(node) {
  return Boolean(node) && typeof node === 'object' && ('ref' in node || 'value' in node);
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

/**
 * Map of every resolvable token id → leaf node. Semantic leaves are registered
 * twice: canonical `semantic.themes.<theme>.<path>` and the alias used by refs,
 * `semantic.<path>` (resolves via the light theme, matching resolveRef).
 */
export function buildTokenIndex(tokens) {
  const map = new Map();
  for (const { path, node } of flattenLeaves(tokens.primitive)) {
    map.set(`primitive.${path.join('.')}`, node);
  }
  for (const { path, node } of flattenLeaves(tokens.experience)) {
    map.set(`experience.${path.join('.')}`, node);
  }
  for (const { path, node } of flattenLeaves(tokens.domain)) {
    map.set(`domain.${path.join('.')}`, node);
  }
  const light = tokens.semantic?.themes?.light ?? {};
  const dark = tokens.semantic?.themes?.dark ?? {};
  const darkSuffixes = new Set(flattenLeaves(dark).map((leaf) => leaf.path.join('.')));
  for (const { path, node } of flattenLeaves(light)) {
    const suffix = path.join('.');
    map.set(`semantic.themes.light.${suffix}`, node);
    if (darkSuffixes.has(suffix)) {
      map.set(`semantic.${suffix}`, node);
    }
  }
  return map;
}

export function parseCssPx(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
    if (px) return Number(px[1]);
    const rem = /^(\d+(?:\.\d+)?)rem$/.exec(value);
    if (rem) return Number(rem[1]) * 16;
  }
  return null;
}

function pxForTokenId(index, tokens, id) {
  const node = index.get(id);
  if (!node) return { known: false, px: null };
  let value;
  try {
    value = resolveRef(node, tokens, new Set(), 'light').value;
  } catch {
    return { known: true, px: null };
  }
  return { known: true, px: parseCssPx(value) };
}

// ── Validation ──────────────────────────────────────────────────────────────

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `failed to read ${label} (${path}): ${err.message}\n  Fix: make it valid JSON`,
    );
  }
}

function checkKeys(node, allowed, where) {
  const errors = [];
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) {
      errors.push(
        `✗ unknown key "${key}" in ${where} (allowed: ${allowed.join(', ')})\n  Fix: remove it or extend schema.json + resolve-contracts BLOCK_FIELDS`,
      );
    }
  }
  return errors;
}

function checkVisibility(node, where) {
  const errors = [];
  if (node && typeof node !== 'object') {
    return [`✗ visibility in ${where} must be an object\n  Fix: use { "mode": "…", "breakpoint": "…" }`];
  }
  errors.push(...checkKeys(node, ['mode', 'breakpoint'], `${where}.visibility`));
  const modes = ['always', 'collapse-to-menu', 'collapse-to-drawer', 'hidden'];
  if (node.mode !== undefined && !modes.includes(node.mode)) {
    errors.push(`✗ visibility.mode "${node.mode}" in ${where} (allowed: ${modes.join(', ')})\n  Fix: use one of the allowed modes`);
  }
  const breakpoints = ['sm', 'md', 'lg', 'xl', '2xl'];
  if (node.breakpoint !== undefined && !breakpoints.includes(node.breakpoint)) {
    errors.push(`✗ visibility.breakpoint "${node.breakpoint}" in ${where} (allowed: ${breakpoints.join(', ')})\n  Fix: use a Tailwind-scale breakpoint or drop the field`);
  }
  return errors;
}

function validateBlock(block, where, index, tokens) {
  const errors = [];
  if (!block || typeof block !== 'object') return errors;
  errors.push(...checkKeys(block, Object.keys(BLOCK_FIELDS), where));
  for (const [field, value] of Object.entries(block)) {
    const spec = BLOCK_FIELDS[field];
    if (spec === undefined) continue; // unknown key already reported by checkKeys
    const ctx = `${where}.${field}`;
    const [kind, detail] = spec.split(':');
    if (kind === 'boolean' && typeof value !== 'boolean') {
      errors.push(`✗ ${ctx} must be a boolean (got ${JSON.stringify(value)})\n  Fix: use true/false`);
    } else if (kind === 'enum' && !detail.split(',').includes(value)) {
      errors.push(`✗ ${ctx} must be one of: ${detail.split(',').join(', ')} (got ${JSON.stringify(value)})\n  Fix: use an allowed strategy`);
    } else if (kind === 'scrollOwner') {
      const ok = typeof value === 'boolean' || (typeof value === 'string' && value.length > 0);
      if (!ok) errors.push(`✗ ${ctx} must be true/false or a non-empty region name (got ${JSON.stringify(value)})\n  Fix: use true/false or name the scroll region`);
    } else if (kind === 'visibility') {
      errors.push(...checkVisibility(value, where));
    } else if (kind === 'token') {
      if (typeof value !== 'string') {
        errors.push(`✗ ${ctx} must be a token id string (got ${JSON.stringify(value)})\n  Fix: reference a design/tokens id like "experience.web.control.md"`);
        continue;
      }
      const { known, px } = pxForTokenId(index, tokens, value);
      if (!known) {
        errors.push(`✗ unknown token id "${value}" in ${ctx}\n  Fix: reference an existing token id (design/tokens/*) or add the token first`);
      } else if (TOKEN_TARGET_FIELDS.has(field) && px === null) {
        errors.push(
          `✗ token "${value}" in ${ctx} does not resolve to a px/rem value (got ${JSON.stringify(resolveRef(index.get(value), tokens, new Set(), 'light').value)})\n  Fix: reference a size/density token; colors are not measurable heights`,
        );
      }
    }
  }
  return errors;
}

const KIND_KEYS = {
  global: ['$description', 'web', 'app'],
  category: ['id', 'extends', '$description', 'web', 'app'],
  pattern: ['id', 'extends', 'patternRef', '$description', 'web', 'app'],
};

function validateNode(node, kind, fileName, index, tokens, errors) {
  if (kind !== 'global') {
    if (typeof node.id !== 'string') {
      errors.push(`✗ ${fileName} is missing "id"\n  Fix: add "id": "${kind}.<name>"`);
      return;
    }
    const expectedPrefix = `${kind}.`;
    if (!node.id.startsWith(expectedPrefix)) {
      errors.push(`✗ ${fileName} has id "${node.id}" (expected "${kind}." prefix)\n  Fix: rename the id`);
    }
    const slug = node.id.slice(expectedPrefix.length);
    if (fileName !== `${slug}.json`) {
      errors.push(`✗ file ${fileName} does not match id "${node.id}" (expected ${slug}.json)\n  Fix: rename the file or the id`);
    }
  }
  errors.push(...checkKeys(node, KIND_KEYS[kind], fileName));
  if (kind === 'pattern' && node.patternRef === undefined) {
    errors.push(`✗ ${fileName} is missing "patternRef"\n  Fix: point at the owning #470 pattern prose (docs/design/design-system/patterns/*.md)`);
  }
  if (node.patternRef !== undefined) {
    if (typeof node.patternRef !== 'string' || !/^docs\/design\/design-system\/patterns\/.*\.md$/.test(node.patternRef)) {
      errors.push(`✗ patternRef "${node.patternRef}" in ${fileName} must be a docs/design/design-system/patterns/*.md path\n  Fix: point at the owning #470 pattern prose`);
    } else if (!existsSync(join(REPO_ROOT, node.patternRef))) {
      errors.push(`✗ patternRef "${node.patternRef}" in ${fileName} does not exist\n  Fix: reference an existing pattern spec (docs/design/design-system/patterns/)`);
    }
  }
  for (const experience of ['web', 'app']) {
    if (node[experience] !== undefined) {
      errors.push(...validateBlock(node[experience], `${fileName}.${experience}`, index, tokens));
    }
  }
}

export function validateTree(tree, tokens) {
  const index = buildTokenIndex(tokens);
  const errors = [];
  const { global = {}, categories = {}, patterns = {} } = tree;

  validateNode(global, 'global', 'global.json', index, tokens, errors);

  const categoryEntries = Object.entries(categories);
  const patternEntries = Object.entries(patterns);
  for (const [fileName, node] of categoryEntries) {
    validateNode(node, 'category', fileName, index, tokens, errors);
  }
  for (const [fileName, node] of patternEntries) {
    validateNode(node, 'pattern', fileName, index, tokens, errors);
  }

  // Unique ids.
  const seen = new Map();
  for (const [fileName, node] of [...categoryEntries, ...patternEntries]) {
    if (seen.has(node.id)) {
      errors.push(`✗ duplicate contract id "${node.id}" (${seen.get(node.id)} and ${fileName})\n  Fix: ids must be unique`);
    }
    seen.set(node.id, fileName);
  }

  const categoryIds = new Set(categoryEntries.map(([, node]) => node.id));
  for (const [fileName, node] of patternEntries) {
    for (const parent of node.extends ?? []) {
      if (!categoryIds.has(parent)) {
        errors.push(`✗ ${fileName} extends unknown category "${parent}"\n  Fix: reference an existing categories/*.json id or remove the entry`);
      }
    }
  }

  // Category inheritance: no cycles, every category reachable from a pattern.
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, chain) => {
    if (visiting.has(id)) {
      errors.push(`✗ category cycle: ${[...chain, id].join(' -> ')}\n  Fix: break the extends cycle`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of categories[seen.get(id)]?.extends ?? []) {
      visit(parent, [...chain, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of categoryIds) visit(id, []);

  const referenced = new Set();
  for (const [, node] of patternEntries) {
    for (const parent of node.extends ?? []) referenced.add(parent);
  }
  const expanded = new Set(referenced);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...expanded]) {
      for (const parent of categories[seen.get(id)]?.extends ?? []) {
        if (!expanded.has(parent)) {
          expanded.add(parent);
          grew = true;
        }
      }
    }
  }
  for (const id of categoryIds) {
    if (!expanded.has(id)) {
      errors.push(`✗ category "${id}" is not referenced by any pattern\n  Fix: extend it from a pattern or remove the file`);
    }
  }

  return { errors, index };
}

// ── Inheritance merge ───────────────────────────────────────────────────────

function orderFor(patternNode, categoriesById) {
  const order = [];
  const pushCat = (id) => {
    const node = categoriesById.get(id);
    if (!node) return;
    for (const parent of node.extends ?? []) pushCat(parent);
    if (!order.includes(id)) order.push(id);
  };
  for (const parent of patternNode.extends ?? []) pushCat(parent);
  return order;
}

function mergeExperience(layers) {
  const out = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      out[key] = value;
    }
  }
  return out;
}

function enrichPx(block, tokens, index) {
  const out = { ...block };
  for (const field of TOKEN_TARGET_FIELDS) {
    const id = out[field];
    if (typeof id === 'string') {
      const { known, px } = pxForTokenId(index, tokens, id);
      if (known && px !== null) out[`${field}Px`] = px;
    }
  }
  return out;
}

function resolvePattern(patternNode, categoriesById, global, tokens, index) {
  const order = orderFor(patternNode, categoriesById);
  const web = mergeExperience([
    global.web,
    ...order.map((id) => categoriesById.get(id).web),
    patternNode.web,
  ]);
  const app = mergeExperience([
    global.app,
    ...order.map((id) => categoriesById.get(id).app),
    patternNode.app,
  ]);
  return {
    id: patternNode.id,
    patternRef: patternNode.patternRef,
    extends: [...(patternNode.extends ?? [])],
    web: enrichPx(web, tokens, index),
    app: enrichPx(app, tokens, index),
  };
}

export function mergeContracts(tree, tokens) {
  const { global, categories, patterns } = tree;
  const { index } = validateTree(tree, tokens);
  const categoriesById = new Map(
    Object.values(categories).map((node) => [node.id, node]),
  );
  const out = {};
  for (const [, node] of Object.entries(patterns)) {
    out[node.id] = resolvePattern(node, categoriesById, global, tokens, index);
  }
  return out;
}

// ── Sources + CLI ───────────────────────────────────────────────────────────

export function loadContractSources(dir = CONTRACTS_DIR) {
  const tree = { global: {}, categories: {}, patterns: {} };
  tree.global = readJson(join(dir, 'global.json'), 'global.json');
  for (const name of readdirSync(join(dir, 'categories')).filter((f) => f.endsWith('.json')).sort()) {
    tree.categories[name] = readJson(join(dir, 'categories', name), `categories/${name}`);
  }
  for (const name of readdirSync(join(dir, 'patterns')).filter((f) => f.endsWith('.json')).sort()) {
    tree.patterns[name] = readJson(join(dir, 'patterns', name), `patterns/${name}`);
  }
  return tree;
}

function reportErrors(errors) {
  for (const error of errors) {
    console.error(error);
  }
  if (errors.length > 0) {
    console.error(`✗ ${errors.length} contract validation error(s)`);
    console.error('  Fix: correct design/contracts/ files, then re-run');
    process.exit(1);
  }
}

function artifactFrom(tree, tokens) {
  const patterns = mergeContracts(tree, tokens);
  return `${JSON.stringify(
    { $note: 'generated — do not edit; run: node design/scripts/resolve-contracts.mjs', patterns },
    null,
    2,
  )}\n`;
}

function checkArtifact(content) {
  const temp = mkdtempSync(join(tmpdir(), 'nession-contracts-'));
  const expectedPath = join(temp, 'contracts.json');
  writeFileSync(expectedPath, content);
  const expected = readFileSync(expectedPath, 'utf8');
  let actual;
  try {
    actual = readFileSync(GENERATED_FILE, 'utf8');
  } catch {
    console.error('✗ design/generated/contracts.json is missing');
    console.error('  Fix: node design/scripts/resolve-contracts.mjs');
    process.exit(1);
  }
  if (actual !== expected) {
    console.error('✗ design/generated/contracts.json is out of date');
    console.error('  Fix: node design/scripts/resolve-contracts.mjs');
    process.exit(1);
  }
}

function runningAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

function main() {
  const tree = loadContractSources();
  const tokens = loadTokens();
  const { errors } = validateTree(tree, tokens);
  reportErrors(errors);
  const content = artifactFrom(tree, tokens);
  if (process.argv.includes('--check')) {
    checkArtifact(content);
    return;
  }
  writeFileSync(GENERATED_FILE, content);
}

if (runningAsCli()) {
  main();
}

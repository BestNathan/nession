import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..', '..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);
const TEST_FILE_RE = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[^.]+$)/;
const STRUCTURAL_CLASS_RE = /^(?:flex|grid|inline-flex|flex-(?:row|col)(?:-reverse)?|flex-wrap|flex-nowrap|items-[^\s]+|justify-[^\s]+|content-[^\s]+|self-[^\s]+|place-[^\s]+|gap(?:-[xy])?-[^\s]+|space-[xy]-[^\s]+|grid-cols-[^\s]+|grid-rows-[^\s]+|auto-cols-[^\s]+|auto-rows-[^\s]+)$/;
const TYPOGRAPHY_CLASS_RE = /^(?:text-(?:xs|sm|base|lg|xl|2xl|3xl|\[[^\]]+\])|font-(?:sans|mono|normal|medium|semibold|bold)|leading-(?:none|tight|snug|normal|relaxed|loose|\[[^\]]+\])|tracking-(?:tighter|tight|normal|wide|wider|widest|\[[^\]]+\]))$/;
const ARBITRARY_METRIC_RE = /^(?:h|w|min-h|min-w|max-h|max-w|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|rounded|text|leading)-\[[^\]]+\]$/;

function isLeaf(node) {
  return Boolean(node) && typeof node === 'object' && ('ref' in node || 'value' in node);
}

function toKebab(parts) {
  return parts
    .map((part) => String(part).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
    .join('-');
}

function walkFiles(dir, predicate = () => true) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(path, predicate));
    } else if (entry.isFile() && predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

function flattenLeaves(node, prefix = [], inheritedDescription = null, inheritedOwner = null) {
  if (isLeaf(node)) {
    return [{
      path: prefix,
      node,
      description: node.$description ?? inheritedDescription ?? null,
      owner: node.$owner ?? inheritedOwner ?? null,
    }];
  }
  if (!node || typeof node !== 'object') return [];
  const description = node.$description ?? inheritedDescription;
  // `$owner` names the pattern or composition a value's *meaning* belongs to,
  // when that is narrower than the experience layer itself. It inherits down
  // the group exactly like `$description`, so it can be stated once on a group
  // or on a single leaf, and an absent value means "generic platform vocabulary"
  // rather than "unknown". See docs/design/design-system/tokens.md.
  const owner = node.$owner ?? inheritedOwner;
  const leaves = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    leaves.push(...flattenLeaves(value, [...prefix, key], description, owner));
  }
  return leaves;
}

function normalizeTokenId(layer, parts) {
  if (layer === 'semantic' && parts[0] === 'themes' && (parts[1] === 'light' || parts[1] === 'dark')) {
    return `semantic.${parts.slice(2).join('.')}`;
  }
  return `${layer}.${parts.join('.')}`;
}

export function normalizeRef(ref) {
  if (typeof ref !== 'string') return [];
  if (ref.startsWith('semantic.themes.light.')) {
    return [`semantic.${ref.slice('semantic.themes.light.'.length)}`];
  }
  if (ref.startsWith('semantic.themes.dark.')) {
    return [`semantic.${ref.slice('semantic.themes.dark.'.length)}`];
  }
  if (ref.includes('{theme}')) {
    return [ref.replace('{theme}', 'light'), ref.replace('{theme}', 'dark')];
  }
  return [ref];
}

function sourceTokenName(id) {
  const parts = id.split('.');
  const layer = parts.shift();
  if (layer === 'primitive') return null;
  if (layer === 'experience') parts.shift();
  return toKebab(parts);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceConsumesName(content, name) {
  const escaped = escapeRegex(name);
  const cssVar = new RegExp(`--${escaped}(?![A-Za-z0-9_-])`);
  if (cssVar.test(content)) return true;
  const utility = new RegExp(`(?:^|[^A-Za-z0-9_-])(?:bg|text|border|ring|outline|fill|stroke|shadow|h|w|min-h|min-w|max-h|max-w|size|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|rounded|leading)-${escaped}(?![A-Za-z0-9_-])`, 'm');
  return utility.test(content);
}

function extractClassStrings(content) {
  const values = [];
  const patterns = [
    /className\s*=\s*["']([^"']+)["']/g,
    /className\s*=\s*\{?`([^`]+)`\}?/g,
    /\bcn\(\s*["']([^"']+)["']/g,
    /\bcn\(\s*`([^`]+)`/g,
    /\bcva\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) values.push(match[1]);
  }
  return values;
}

export function extractLayoutSignatures(content) {
  const signatures = [];
  for (const value of extractClassStrings(content)) {
    const tokens = value.split(/\s+/).filter(Boolean);
    const structural = tokens.filter((token) => STRUCTURAL_CLASS_RE.test(token));
    if (!structural.some((token) => token === 'flex' || token === 'inline-flex' || token === 'grid')) continue;
    signatures.push([...new Set(structural)].sort().join(' '));
  }
  return signatures.filter(Boolean);
}

function extractTypographyClasses(content) {
  const classes = [];
  for (const value of extractClassStrings(content)) {
    for (const token of value.split(/\s+/).filter(Boolean)) {
      if (TYPOGRAPHY_CLASS_RE.test(token)) classes.push(token);
    }
  }
  return classes;
}

function extractArbitraryMetrics(content) {
  const metrics = [];
  for (const value of extractClassStrings(content)) {
    for (const token of value.split(/\s+/).filter(Boolean)) {
      if (ARBITRARY_METRIC_RE.test(token)) metrics.push(token);
    }
  }
  return metrics;
}

function logicalMode(layer, parts) {
  if (layer === 'semantic' && parts[0] === 'themes') return parts[1];
  if (layer === 'experience') return parts[0];
  return null;
}

function loadTokenRecords(root) {
  const files = [
    ['primitive', join(root, 'design/tokens/primitive.json')],
    ['semantic', join(root, 'design/tokens/semantic.json')],
    ['domain', join(root, 'design/tokens/domain.json')],
    ['experience', join(root, 'design/tokens/experience/web.json')],
    ['experience', join(root, 'design/tokens/experience/app.json')],
  ];
  const byId = new Map();
  for (const [layer, path] of files) {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    let prefix = [];
    if (layer === 'experience') {
      prefix = [path.endsWith('/app.json') ? 'app' : 'web'];
    }
    for (const leaf of flattenLeaves(json, prefix)) {
      const id = normalizeTokenId(layer, leaf.path);
      const record = byId.get(id) ?? {
        id,
        layer,
        modes: [],
        sourcePaths: [],
        descriptions: [],
        refs: [],
        downstream: [],
        productionConsumers: [],
        owner: null,
      };
      const mode = logicalMode(layer, leaf.path);
      if (mode && !record.modes.includes(mode)) record.modes.push(mode);
      record.sourcePaths.push(`${relative(root, path)}#${leaf.path.join('.')}`);
      if (leaf.owner) record.owner = leaf.owner;
      if (leaf.description && !record.descriptions.includes(leaf.description)) record.descriptions.push(leaf.description);
      if ('ref' in leaf.node) {
        for (const ref of normalizeRef(leaf.node.ref)) {
          if (!record.refs.includes(ref)) record.refs.push(ref);
        }
      }
      byId.set(id, record);
    }
  }

  for (const record of byId.values()) {
    for (const ref of record.refs) {
      const target = byId.get(ref);
      if (target && !target.downstream.includes(record.id)) target.downstream.push(record.id);
    }
  }
  return byId;
}

function readProductionSources(root) {
  const src = join(root, 'web/src');
  return walkFiles(src, (path) => SOURCE_EXTENSIONS.has(extname(path)) && !TEST_FILE_RE.test(relative(src, path)))
    .map((path) => ({
      path,
      relativePath: relative(root, path).replaceAll('\\', '/'),
      content: readFileSync(path, 'utf8'),
    }));
}

function attachDirectConsumers(tokenRecords, sources) {
  for (const record of tokenRecords.values()) {
    const name = sourceTokenName(record.id);
    if (!name) continue;
    for (const source of sources) {
      if (sourceConsumesName(source.content, name)) record.productionConsumers.push(source.relativePath);
    }
  }
}

function effectiveConsumers(id, tokenRecords, memo = new Map(), visiting = new Set()) {
  if (memo.has(id)) return memo.get(id);
  if (visiting.has(id)) return [];
  visiting.add(id);
  const record = tokenRecords.get(id);
  const consumers = new Set(record?.productionConsumers ?? []);
  for (const child of record?.downstream ?? []) {
    for (const file of effectiveConsumers(child, tokenRecords, memo, visiting)) consumers.add(file);
  }
  visiting.delete(id);
  const result = [...consumers].sort();
  memo.set(id, result);
  return result;
}

export function classifyZeroConsumer(record) {
  if (record.effectiveConsumers.length > 0) {
    return { status: 'active', reason: 'Reaches shipping production code directly or through a downstream token.' };
  }
  if (record.layer === 'primitive') {
    return {
      status: 'intentional',
      reason: 'Primitive is source material and is not a product-component API; zero direct shipping consumers is legal and remains visible in the inventory.',
    };
  }
  if (record.layer === 'semantic') {
    if (/^semantic\.(?:chart-|sidebar)/.test(record.id)) {
      return {
        status: 'reserved',
        reason: 'Reserved compatibility vocabulary for upstream shadcn semantics; keep visible until an explicit removal/migration slice proves it unnecessary.',
      };
    }
    return {
      status: 'reserved',
      reason: 'Shared semantic vocabulary currently has no effective shipping consumer; retain as an explicit reserved item, not as evidence that the capability is implemented.',
    };
  }
  if (record.layer === 'domain') {
    return {
      status: 'reserved',
      reason: 'Canonical product-domain vocabulary currently has no effective shipping consumer. Quiet/absent product state can be intentional, but this token must not be counted as implemented UI.',
    };
  }
  return {
    status: 'reserved',
    reason: 'Platform experience vocabulary currently has no effective shipping consumer; keep it visible as reserved until a consumer or removal slice is approved.',
  };
}

function auditTokens(root, sources) {
  const records = loadTokenRecords(root);
  attachDirectConsumers(records, sources);
  const memo = new Map();
  for (const record of records.values()) {
    record.refs.sort();
    record.downstream.sort();
    record.productionConsumers = [...new Set(record.productionConsumers)].sort();
    record.effectiveConsumers = effectiveConsumers(record.id, records, memo);
    record.consumerStatus = classifyZeroConsumer(record);
  }
  const missingRefs = [];
  for (const record of records.values()) {
    for (const ref of record.refs) {
      if (!records.has(ref)) missingRefs.push({ from: record.id, ref });
    }
  }
  return {
    records: [...records.values()].sort((a, b) => a.id.localeCompare(b.id)),
    missingRefs,
  };
}

function importUsageCount(sources, stem) {
  const candidates = [
    `@/components/ui/${stem}`,
    `components/ui/${stem}`,
  ];
  const files = new Set();
  for (const source of sources) {
    if (candidates.some((candidate) => source.content.includes(candidate))) files.add(source.relativePath);
  }
  return [...files].sort();
}

function componentBase(content) {
  const imports = [...content.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  return imports.filter((value) => value.startsWith('@base-ui/') || value.startsWith('@radix-ui/') || value === 'sonner' || value === 'react-resizable-panels');
}

function auditComponents(root, sources) {
  const dir = join(root, 'web/src/components/ui');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.tsx'))
    .sort();
  return files.map((file) => {
    const path = join(dir, file);
    const content = readFileSync(path, 'utf8');
    const stem = file.slice(0, -4);
    const consumers = importUsageCount(sources.filter((source) => source.path !== path), stem);
    const wrapper = /^[A-Z]/.test(stem);
    let classification = wrapper ? 'wrapper/adapter' : 'nession-normalized primitive';
    if (consumers.length === 0) classification = wrapper ? 'wrapper/adapter-unused' : 'candidate-removal';
    return {
      component: stem,
      file: relative(root, path).replaceAll('\\', '/'),
      classification,
      base: componentBase(content),
      consumerCount: consumers.length,
      consumers,
    };
  });
}

function auditLayout(sources) {
  const groups = new Map();
  const arbitrary = new Map();
  for (const source of sources) {
    for (const signature of extractLayoutSignatures(source.content)) {
      const record = groups.get(signature) ?? { signature, occurrences: 0, files: new Set() };
      record.occurrences += 1;
      record.files.add(source.relativePath);
      groups.set(signature, record);
    }
    for (const metric of extractArbitraryMetrics(source.content)) {
      const record = arbitrary.get(metric) ?? { metric, occurrences: 0, files: new Set() };
      record.occurrences += 1;
      record.files.add(source.relativePath);
      arbitrary.set(metric, record);
    }
  }
  return {
    repeatedRelationships: [...groups.values()]
      .map((record) => ({ ...record, files: [...record.files].sort() }))
      .filter((record) => record.files.length >= 2)
      .sort((a, b) => b.files.length - a.files.length || b.occurrences - a.occurrences || a.signature.localeCompare(b.signature)),
    arbitraryMetrics: [...arbitrary.values()]
      .map((record) => ({ ...record, files: [...record.files].sort() }))
      .sort((a, b) => b.occurrences - a.occurrences || a.metric.localeCompare(b.metric)),
  };
}

function auditTypography(root, sources) {
  const classes = new Map();
  for (const source of sources) {
    for (const className of extractTypographyClasses(source.content)) {
      const record = classes.get(className) ?? { className, occurrences: 0, files: new Set() };
      record.occurrences += 1;
      record.files.add(source.relativePath);
      classes.set(className, record);
    }
  }
  const experienceFiles = [
    join(root, 'design/tokens/experience/web.json'),
    join(root, 'design/tokens/experience/app.json'),
  ];
  const experienceRoles = [];
  for (const path of experienceFiles) {
    const platform = path.endsWith('/app.json') ? 'app' : 'web';
    const json = JSON.parse(readFileSync(path, 'utf8'));
    for (const leaf of flattenLeaves(json, [platform])) {
      const name = leaf.path.join('.');
      if (/fontSize|lineHeight/i.test(name)) {
        experienceRoles.push({ token: `experience.${name}`, description: leaf.description });
      }
    }
  }
  return {
    rawClasses: [...classes.values()]
      .map((record) => ({ ...record, files: [...record.files].sort() }))
      .sort((a, b) => b.occurrences - a.occurrences || a.className.localeCompare(b.className)),
    experienceRoles: experienceRoles.sort((a, b) => a.token.localeCompare(b.token)),
  };
}

function listJsonFiles(dir) {
  if (!statSync(dir).isDirectory()) return [];
  return walkFiles(dir, (path) => path.endsWith('.json')).map((path) => path.replaceAll('\\', '/')).sort();
}

function auditValidation(root) {
  const contractRoot = join(root, 'design/contracts');
  const patternContracts = listJsonFiles(join(contractRoot, 'patterns')).map((path) => relative(root, path).replaceAll('\\', '/'));
  const categoryContracts = listJsonFiles(join(contractRoot, 'categories')).map((path) => relative(root, path).replaceAll('\\', '/'));
  const e2eRoot = join(root, 'web/e2e');
  const e2eFiles = statSafe(e2eRoot) ? walkFiles(e2eRoot, (path) => /\.(?:ts|tsx)$/.test(path)).map((path) => relative(root, path).replaceAll('\\', '/')).sort() : [];
  return {
    staticGate: [
      'design/scripts/generate-tokens.mjs --check',
      'design/scripts/resolve-contracts.mjs --check',
      'design/scripts/*.test.mjs',
    ],
    patternContracts,
    categoryContracts,
    browserEvidenceFiles: e2eFiles,
    visualBaselineOwner: 'docs/design/design-system/validation.md',
  };
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function buildInventory(root = DEFAULT_ROOT) {
  const sources = readProductionSources(root);
  return {
    schemaVersion: 1,
    scope: {
      productionSources: 'web/src (tests excluded)',
      note: 'Counts are lexical evidence. They identify ownership/coverage questions; they do not replace browser or contract validation.',
      patternDocs: readPatternDocs(root),
    },
    tokens: auditTokens(root, sources),
    typography: auditTypography(root, sources),
    layout: auditLayout(sources),
    components: auditComponents(root, sources),
    validation: auditValidation(root),
  };
}

/** Pattern names a token `$owner` may name — read from the docs tree, not a literal list. */
export function readPatternDocs(root) {
  const dir = join(root, 'docs/design/design-system/patterns');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => `pattern.${name.slice(0, -3)}`)
    .sort();
}

function summary(inventory) {
  const zero = inventory.tokens.records.filter((record) => record.effectiveConsumers.length === 0);
  const byStatus = zero.reduce((acc, record) => {
    (acc[record.consumerStatus.status] ??= []).push(record);
    return acc;
  }, {});
  return {
    tokenCount: inventory.tokens.records.length,
    zeroEffectiveConsumers: zero.length,
    zeroConsumerStatus: Object.fromEntries(Object.entries(byStatus).map(([key, records]) => [key, records.length])),
    missingTokenRefs: inventory.tokens.missingRefs.length,
    componentCount: inventory.components.length,
    unusedComponents: inventory.components.filter((component) => component.classification.includes('unused') || component.classification === 'candidate-removal').length,
    repeatedLayoutRelationships: inventory.layout.repeatedRelationships.length,
    arbitraryMetrics: inventory.layout.arbitraryMetrics.length,
    typographyClasses: inventory.typography.rawClasses.length,
    experienceTypographyTokens: inventory.typography.experienceRoles.length,
    patternContracts: inventory.validation.patternContracts.length,
  };
}

function markdown(inventory) {
  const info = summary(inventory);
  const zero = inventory.tokens.records.filter((record) => record.effectiveConsumers.length === 0);
  const lines = [
    '# Design System Inventory',
    '',
    '> Generated evidence from `design/scripts/audit-design-system.mjs`. This is an audit view, not a new design source of truth.',
    '',
    '## Summary',
    '',
    `- Logical tokens: ${info.tokenCount}`,
    `- Tokens with zero effective shipping consumers: ${info.zeroEffectiveConsumers}`,
    `- Missing token references: ${info.missingTokenRefs}`,
    `- UI components: ${info.componentCount}`,
    `- Unused/removal-candidate UI components: ${info.unusedComponents}`,
    `- Repeated cross-file layout signatures: ${info.repeatedLayoutRelationships}`,
    `- Arbitrary metric signatures: ${info.arbitraryMetrics}`,
    `- Distinct raw typography classes: ${info.typographyClasses}`,
    `- Experience-level typography tokens: ${info.experienceTypographyTokens}`,
    `- Pattern contracts: ${info.patternContracts}`,
    '',
    '## Zero-effective-consumer tokens',
    '',
    '| Token | Layer | Status | Downstream refs | Reason |',
    '|---|---|---|---:|---|',
    ...zero.map((record) => `| \`${record.id}\` | ${record.layer} | ${record.consumerStatus.status} | ${record.downstream.length} | ${record.consumerStatus.reason.replaceAll('|', '\\|')} |`),
    '',
    '## Component / shadcn boundary',
    '',
    '| Component | Classification | Consumers | Upstream base |',
    '|---|---|---:|---|',
    ...inventory.components.map((component) => `| \`${component.component}\` | ${component.classification} | ${component.consumerCount} | ${component.base.length ? component.base.map((item) => `\`${item}\``).join(', ') : 'none'} |`),
    '',
    '## Repeated layout relationships',
    '',
    ...inventory.layout.repeatedRelationships.slice(0, 20).map((record) => `- **${record.files.length} files / ${record.occurrences} occurrences** — \`${record.signature}\` — ${record.files.join(', ')}`),
    '',
    '## Typography evidence',
    '',
    'Most frequent raw typography classes:',
    '',
    ...inventory.typography.rawClasses.slice(0, 20).map((record) => `- \`${record.className}\`: ${record.occurrences} occurrences / ${record.files.length} files`),
    '',
    'Experience-level typography tokens:',
    '',
    ...inventory.typography.experienceRoles.map((record) => `- \`${record.token}\`${record.description ? ` — ${record.description}` : ''}`),
    '',
  ];
  return lines.join('\n');
}

export function checkInventory(inventory) {
  const errors = [];
  if (inventory.tokens.missingRefs.length > 0) {
    for (const missing of inventory.tokens.missingRefs) errors.push(`missing token ref: ${missing.from} -> ${missing.ref}`);
  }
  for (const record of inventory.tokens.records) {
    if (record.effectiveConsumers.length === 0 && !record.consumerStatus?.status) {
      errors.push(`zero-consumer token has no classification: ${record.id}`);
    }
  }
  for (const problem of checkOwnership(inventory)) errors.push(problem);
  if (inventory.components.length === 0) errors.push('components/ui inventory is empty');
  return errors;
}

/**
 * Every `$owner` in a token source must name a pattern that actually exists.
 *
 * The annotation is the whole mechanism by which a pattern-specific metric
 * explains itself, so an owner that resolves to nothing is worse than no owner:
 * it reads as a decision while being a typo. `$owner` is checked against the
 * pattern docs rather than a hand-kept list of legal names, so adding a pattern
 * doc is what makes a new owner legal.
 */
export function checkOwnership(inventory) {
  const problems = [];
  const known = new Set(inventory.scope?.patternDocs ?? []);
  for (const record of inventory.tokens.records) {
    if (!record.owner) continue;
    if (!known.has(record.owner)) {
      problems.push(
        `unknown token owner: ${record.id} declares $owner "${record.owner}", ` +
          `which is not a docs/design/design-system/patterns/*.md name`,
      );
    }
  }
  return problems;
}

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    check: argv.includes('--check'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const inventory = buildInventory(DEFAULT_ROOT);
  const errors = checkInventory(inventory);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  } else if (options.check) {
    process.stdout.write(`${JSON.stringify(summary(inventory), null, 2)}\n`);
  } else {
    process.stdout.write(`${markdown(inventory)}\n`);
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exitCode = 1;
  }
}

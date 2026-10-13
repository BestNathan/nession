import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ID = /^[a-z][a-z0-9-]*$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDERS = new Set(['cursor', 'claude-code']);
const TOOL_MAP = Object.freeze({
  cursor: {
    'repo.read': 'read', 'repo.search': 'grep', 'repo.edit': 'edit',
    'shell.test': 'bash', 'github.issue.read': 'mcp',
    'github.pr.read': 'mcp',
  },
  'claude-code': {
    'repo.read': 'Read', 'repo.search': 'Grep', 'repo.edit': 'Edit',
    'shell.test': 'Bash', 'github.issue.read': 'mcp',
    'github.pr.read': 'mcp',
  },
});

function deny(message) { throw new Error('agent harness: ' + message); }
function nonEmptyString(value) { return typeof value === 'string' && value.length > 0; }
function validId(value, label) {
  if (!nonEmptyString(value) || !ID.test(value)) deny('invalid ' + label);
}
function uniqueStrings(value, label, expression = CAPABILITY) {
  if (!Array.isArray(value)) deny(label + ' must be an array');
  const all = new Set();
  for (const x of value) {
    if (!nonEmptyString(x) || !expression.test(x) || all.has(x)) deny('invalid/duplicate ' + label + ': ' + x);
    all.add(x);
  }
  return [...all].sort();
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  if (value === undefined || !['boolean', 'number', 'string'].includes(typeof value) && value !== null) {
    deny('unsupported canonical value');
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

export function validateRegistry(registry) {
  if (!registry || registry.schema_version !== 1) deny('unsupported registry schema');
  if (!registry.roles || !registry.instances || !Array.isArray(registry.external_dependencies)) deny('missing registry sections');
  const environments = new Set();
  for (const [role, config] of Object.entries(registry.roles)) {
    validId(role, 'role');
    uniqueStrings(config?.tasks, 'tasks', ID);
    for (const family of ['tools', 'skills', 'mcp', 'plugins']) {
      uniqueStrings(config?.capabilities?.[family], family);
    }
  }
  for (const [agentId, config] of Object.entries(registry.instances)) {
    validId(agentId, 'agent_id');
    if (!Object.hasOwn(registry.roles, config?.role)) deny('unknown role for ' + agentId);
    if (!PROVIDERS.has(config?.provider)) deny('unsupported provider for ' + agentId);
    if (!nonEmptyString(config?.environment) || !ID.test(config.environment)) deny('invalid environment for ' + agentId);
    if (environments.has(config.environment)) deny('duplicate environment binding: ' + config.environment);
    environments.add(config.environment);
    const allowedKeys = new Set(['role', 'provider', 'environment']);
    if (Object.keys(config).some((key) => !allowedKeys.has(key))) deny('unexpected/secret instance property for ' + agentId);
  }
  const depIds = new Set();
  for (const dep of registry.external_dependencies) {
    validId(dep?.id, 'dependency id');
    if (depIds.has(dep.id)) deny('duplicate dependency: ' + dep.id);
    depIds.add(dep.id);
    if (!['plugin', 'skill', 'mcp', 'cli', 'sdk', 'registry'].includes(dep.kind)) deny('unsupported dependency kind');
    if (!nonEmptyString(dep.revision) || /^(main|master|latest|head|\*)$/i.test(dep.revision)) deny('unversioned external dependency: ' + dep.id);
    if (!nonEmptyString(dep.path) || path.isAbsolute(dep.path) || dep.path.split('/').includes('..')) deny('unsafe dependency path: ' + dep.id);
    if (!SHA256.test(dep.sha256)) deny('invalid sha256 for ' + dep.id);
  }
  return registry;
}

export function resolveIdentity(registry, agentId, task, environment) {
  validateRegistry(registry);
  validId(agentId, 'agent id');
  const instance = registry.instances[agentId];
  if (!instance) deny('unregistered agent_id: ' + agentId);
  if (environment !== instance.environment) deny('environment does not match approved agent identity');
  if (!registry.roles[instance.role].tasks.includes(task)) deny('unauthorized task for agent');
  return Object.freeze({ agent_id: agentId, role: instance.role, provider: instance.provider, environment, task });
}

function safeTree(root, relativePath) {
  const full = path.resolve(root, relativePath);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) deny('path traversal');
  const files = [];
  function scan(file, rel) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) deny('external dependency has symlink: ' + rel);
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) scan(path.join(file, name), path.posix.join(rel, name));
    } else if (stat.isFile()) {
      files.push({ path: rel, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
    } else {
      deny('unsupported dependency file: ' + rel);
    }
  }
  scan(full, '.');
  if (!files.length) deny('empty external dependency tree');
  return digest(files);
}

export function verifyExternalDependencies(registry, root) {
  validateRegistry(registry);
  return registry.external_dependencies.map((dep) => {
    const actual = safeTree(root, dep.path);
    if (actual !== dep.sha256) deny('external dependency sha256 mismatch: ' + dep.id);
    return { id: dep.id, kind: dep.kind, revision: dep.revision, sha256: actual };
  });
}

export function resolveProviderPlan(registry, identity, verifiedExternal = []) {
  const role = registry.roles[identity.role];
  if (!role) deny('unknown role');
  const nativeMap = TOOL_MAP[identity.provider];
  if (!nativeMap) deny('unknown provider');
  const tools = uniqueStrings(role.capabilities.tools, 'tools');
  const nativeTools = tools.map((tool) => {
    const nativeName = nativeMap[tool];
    if (!nativeName) deny('provider ' + identity.provider + ' does not support ' + tool);
    return { id: tool, native_name: nativeName };
  });
  const dependencies = registry.external_dependencies;
  if (verifiedExternal.length !== dependencies.length ||
      dependencies.some((dep) => !verifiedExternal.some((entry) => entry.id === dep.id && entry.sha256 === dep.sha256))) {
    deny('unverified external dependencies');
  }
  return {
    identity,
    canonical_capabilities: role.capabilities,
    native_tools: nativeTools,
    external: verifiedExternal,
  };
}

export function verifyEffectiveHarness(plan, observed, sourceSha, providerVersion) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '')) deny('source SHA must be exact');
  if (!nonEmptyString(providerVersion)) deny('missing provider runtime version');
  if (!observed || !Array.isArray(observed.tools) || !Array.isArray(observed.skills) ||
      !Array.isArray(observed.mcp) || !Array.isArray(observed.plugins)) deny('missing native loaded capability report');
  for (const [family, expected] of Object.entries({
    tools: plan.native_tools.map((x) => x.native_name),
    skills: plan.canonical_capabilities.skills,
    mcp: plan.canonical_capabilities.mcp,
    plugins: plan.canonical_capabilities.plugins,
  })) {
    const loaded = new Set(observed[family]);
    for (const required of expected) if (!loaded.has(required)) deny('required ' + family + ' was not loaded: ' + required);
  }
  const effective = {
    schema_version: 1,
    identity: plan.identity,
    canonical_capabilities: plan.canonical_capabilities,
    native_tools: plan.native_tools,
    loaded: observed,
    external: plan.external,
    source_sha: sourceSha,
    provider_version: providerVersion,
  };
  return { ...effective, sha256: digest(effective) };
}

export function loadRegistry(file) {
  return validateRegistry(JSON.parse(readFileSync(file, 'utf8')));
}

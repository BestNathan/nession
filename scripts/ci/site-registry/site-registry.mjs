#!/usr/bin/env node
// Canonical reviewed Nession site registry (#4589). One owner for site
// identity, private-by-default visibility, the MCP-only public allowlist,
// backend/route identity and the GitOps render comparison. Deployment
// desired hosts stay editable only on the gitops branch (#4588 owns the
// host migration); this module validates them against the reviewed
// registry at pinned revisions and never writes a second desired state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REGISTRY_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ZONE = 'bestnathan.top';
export const ENVIRONMENTS = Object.freeze(['staging', 'staging-01', 'preprod', 'production']);
export const SERVICES = Object.freeze(['server', 'agent', 'ui', 'mcp']);
export const LAN_ANSWER_REF = 'LAN_GATEWAY_IP';
export const PUBLIC_ORIGIN_REF = 'CLOUDFLARE_ORIGIN_IPV4';
export const SENSITIVE_OPERATIONS = Object.freeze([
  'public-activate', 'adopt', 'delete', 'visibility-transition',
  'origin-change', 'gateway-change', 'retire-origin-ca'
]);

const BACKEND_PORTS = Object.freeze({ server: 10080, agent: 10080, ui: 80, mcp: 9090 });
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function registryHash(registry) {
  return sha256Hex(canonicalJson(registry));
}

// Contract naming: env-service-nession.bestnathan.top, omitting the
// production environment prefix and the server service prefix.
export function expectedHostLabel(environment, service) {
  const env = environment === 'production' ? '' : environment + '-';
  const svc = service === 'server' ? '' : service + '-';
  return env + svc + 'nession';
}

function fail(invariant, detail) {
  throw new Error('Site registry invariant violated: ' + invariant +
    (detail ? ' (' + detail + ')' : ''));
}

function isZoneName(name) {
  return typeof name === 'string' && name.endsWith('.' + ZONE) &&
    name.length > ZONE.length + 1 && !name.includes('*');
}

export function validateRegistry(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('registry-object');
  if (data.version !== 1) fail('registry-version', 'expected version 1');
  if (!Number.isInteger(data.issue) || data.issue <= 0) fail('registry-issue');
  if (data.zone !== ZONE) fail('registry-zone', 'only the reviewed bestnathan.top zone is allowed');
  if (!Array.isArray(data.environments) || !Array.isArray(data.services) ||
      !Array.isArray(data.publicAllowlist) || !Array.isArray(data.sites)) {
    fail('registry-shape');
  }
  for (const env of data.environments) {
    if (!ENVIRONMENTS.includes(env)) fail('unknown-environment', String(env));
  }
  for (const service of data.services) {
    if (!SERVICES.includes(service)) fail('unknown-service', String(service));
  }
  const ids = new Set();
  const hostnames = new Set();
  for (const site of data.sites) {
    if (!site || typeof site !== 'object') fail('site-object');
    const id = site.id;
    if (typeof id !== 'string' || !KEBAB.test(id)) fail('site-id', String(id));
    if (ids.has(id)) fail('duplicate-site-id', id);
    ids.add(id);
    if (!data.environments.includes(site.environment)) fail('unknown-environment', String(site.environment));
    if (!data.services.includes(site.service)) fail('unknown-service', String(site.service));
    if (id !== site.environment + '-' + site.service) fail('site-id-identity', id);
    const expected = expectedHostLabel(site.environment, site.service) + '.' + ZONE;
    if (site.fqdn !== expected) fail('site-fqdn-naming', id + ' must be ' + expected);
    if (!isZoneName(site.fqdn) || !LABEL.test(site.fqdn.slice(0, -(ZONE.length + 1)))) {
      fail('site-fqdn-single-label', id);
    }
    if (hostnames.has(site.fqdn)) fail('duplicate-hostname', site.fqdn);
    hostnames.add(site.fqdn);
    if (site.legacyFqdn !== null) {
      if (!isZoneName(site.legacyFqdn) || site.legacyFqdn === site.fqdn ||
          site.legacyFqdn.slice(0, -(ZONE.length + 1)).split('.').length < 2) {
        fail('legacy-fqdn', id + ' legacy alias must be a reviewed nested pre-migration name');
      }
      if (hostnames.has(site.legacyFqdn)) fail('duplicate-hostname', site.legacyFqdn);
      hostnames.add(site.legacyFqdn);
    }
    if (site.visibility !== 'private' && site.visibility !== 'public') fail('visibility', id);
    if (site.visibility === 'public') {
      if (site.service !== 'mcp') fail('public-non-mcp', id);
      if (!data.publicAllowlist.includes(id)) fail('public-not-allowlisted', id);
      if (site.publicOrigin !== PUBLIC_ORIGIN_REF) fail('public-origin-ref', id);
      if (typeof site.ownershipMarker !== 'string' ||
          !/^managed-by:nession:site=[a-z0-9-]+:issue=[1-9][0-9]*$/.test(site.ownershipMarker) ||
          !site.ownershipMarker.includes('site=' + id + ':')) {
        fail('ownership-marker', id);
      }
    } else {
      if (data.publicAllowlist.includes(id)) fail('allowlist-private-site', id);
      if ('publicOrigin' in site || 'ownershipMarker' in site) fail('private-public-fields', id);
    }
    if (typeof site.enabled !== 'boolean') fail('enabled-flag', id);
    if (!site.backend || typeof site.backend !== 'object') fail('backend-object', id);
    const expectedService = site.service === 'mcp'
      ? 'nession-mcp-' + site.environment
      : 'nession-' + site.service;
    if (site.backend.service !== expectedService) fail('backend-identity', id);
    if (site.backend.port !== BACKEND_PORTS[site.service]) fail('backend-port', id);
    const expectedRoute = site.service === 'mcp'
      ? { path: '/mcp', pathType: 'Exact' }
      : { path: '/', pathType: 'Prefix' };
    if (!site.route || site.route.path !== expectedRoute.path ||
        site.route.pathType !== expectedRoute.pathType) fail('route-policy', id);
    if (site.lanDns !== LAN_ANSWER_REF) fail('lan-dns-ref', id);
    if (!site.gitops || typeof site.gitops !== 'object') fail('gitops-ref', id);
    for (const key of ['path', 'ingress']) {
      const value = site.gitops[key];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') ||
          value.split('/').some(part => part === '' || part === '.' || part === '..')) {
        fail('gitops-ref', id + '.' + key);
      }
    }
    if (site.service === 'mcp' && typeof site.gitops.kustomization !== 'string') {
      fail('gitops-kustomization-ref', id);
    }
  }
  for (const id of data.publicAllowlist) {
    const site = data.sites.find(entry => entry.id === id);
    if (!site || site.service !== 'mcp' || site.visibility !== 'public') {
      fail('public-allowlist-member', String(id));
    }
  }
  return data;
}

export function validateApprovals(data, registry) {
  if (!data || typeof data !== 'object' || data.version !== 1 ||
      !Number.isInteger(data.issue) || !Array.isArray(data.approvals)) {
    fail('approvals-shape');
  }
  const ids = new Set();
  for (const entry of data.approvals) {
    if (!entry || typeof entry !== 'object') fail('approval-object');
    if (typeof entry.id !== 'string' || !KEBAB.test(entry.id)) fail('approval-id', String(entry.id));
    if (ids.has(entry.id)) fail('duplicate-approval-id', entry.id);
    ids.add(entry.id);
    const site = registry.sites.find(candidate => candidate.id === entry.site);
    if (!site) fail('approval-unknown-site', String(entry.site));
    if (!SENSITIVE_OPERATIONS.includes(entry.operation)) fail('approval-operation', String(entry.operation));
    if (!entry.scope || entry.scope.fqdn !== site.fqdn) fail('approval-scope-fqdn', entry.id);
    if ('visibility' in entry.scope && entry.scope.visibility !== site.visibility) {
      fail('approval-scope-visibility', entry.id);
    }
    if ('originRef' in entry.scope &&
        (entry.scope.originRef !== PUBLIC_ORIGIN_REF || site.visibility !== 'public')) {
      fail('approval-scope-origin', entry.id);
    }
    if ('answerRef' in entry.scope && entry.scope.answerRef !== LAN_ANSWER_REF) {
      fail('approval-scope-answer', entry.id);
    }
    if ('recordId' in entry.scope) {
      if (!/^[0-9a-f]{32}$/i.test(entry.scope.recordId ?? '') ||
          !['delete', 'adopt'].includes(entry.operation)) {
        fail('approval-scope-record', entry.id);
      }
    }
    if ('recordType' in entry.scope && !['A', 'AAAA', 'CNAME'].includes(entry.scope.recordType)) {
      fail('approval-scope-record-type', entry.id);
    }
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) fail('approval-issue', entry.id);
    if (entry.lineage === true) {
      if ('registryHash' in entry.scope || 'registryHash' in entry) fail('approval-lineage-hash', entry.id);
    } else {
      if (typeof entry.approvedBy !== 'string' || entry.approvedBy.length === 0) fail('approval-approver', entry.id);
      if (typeof entry.approvedAt !== 'string' ||
          !/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(entry.approvedAt)) {
        fail('approval-date', entry.id);
      }
      if (!SHA256.test(entry.registryHash ?? '')) fail('approval-registry-binding', entry.id);
    }
  }
  return data;
}

export function loadRegistry({ dir = REGISTRY_DIR } = {}) {
  const registry = validateRegistry(JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8')));
  const approvals = validateApprovals(
    JSON.parse(fs.readFileSync(path.join(dir, 'approvals.json'), 'utf8')), registry);
  return Object.freeze({ registry, approvals, registryHash: registryHash(registry) });
}

// A reviewed explicit approval must match the exact desired state. New
// (non-lineage) approvals are bound to the registry content hash at review
// time; any registry change requires a fresh reviewed approval.
export function findApproval(approvals, { site, operation, registryHash: currentHash, scope = {} }) {
  for (const entry of approvals.approvals) {
    if (entry.site !== site || entry.operation !== operation) continue;
    if (entry.scope.fqdn !== scope.fqdn) continue;
    if ('visibility' in scope && entry.scope.visibility !== scope.visibility) continue;
    if ('originRef' in scope && entry.scope.originRef !== scope.originRef) continue;
    if ('answerRef' in scope && entry.scope.answerRef !== scope.answerRef) continue;
    if ('recordId' in scope && entry.scope.recordId !== scope.recordId) continue;
    if ('recordType' in scope && entry.scope.recordType !== scope.recordType) continue;
    if (entry.lineage === true) return entry;
    if (entry.registryHash === currentHash) return entry;
  }
  return null;
}

export function validateGatewayIpv4(ip) {
  if (typeof ip !== 'string' || net.isIP(ip) !== 4) {
    throw new Error('LAN_GATEWAY_IP must be one fixed internal IPv4 address');
  }
  const [a, b] = ip.split('.').map(Number);
  const privateRange = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!privateRange) {
    throw new Error('LAN_GATEWAY_IP must be an RFC1918 internal ingress address, not public or reserved space');
  }
  return ip;
}

// Exact intended LAN host set: one canonical rewrite per enabled site.
export function renderLanPlan(registry, gatewayIp) {
  validateRegistry(registry);
  validateGatewayIpv4(gatewayIp);
  return registry.sites
    .filter(site => site.enabled)
    .map(site => ({ site: site.id, domain: site.fqdn, answer: gatewayIp, answerRef: LAN_ANSWER_REF }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

// Only approved, enabled, allowlisted MCP sites may map to public records.
export function renderPublicPlan(registry) {
  validateRegistry(registry);
  return registry.sites
    .filter(site => site.enabled && site.visibility === 'public' &&
      registry.publicAllowlist.includes(site.id))
    .map(site => ({
      site: site.id, environment: site.environment, hostname: site.fqdn,
      recordType: 'A', proxied: true, ttl: 1, comment: site.ownershipMarker,
      originRef: PUBLIC_ORIGIN_REF
    }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
}

// Strict, fail-closed reader for the repository-owned Ingress manifest shape.
// Unknown structures are rejected instead of guessed; nhome.local rules are
// preserved untouched and reported separately.
export function parseIngressDocuments(text) {
  if (typeof text !== 'string') throw new Error('GitOps ingress readback missing');
  const documents = [];
  for (const chunk of text.split(/^---[ \t]*$/m)) {
    if (!/^\s*kind:\s*Ingress\s*$/m.test(chunk)) continue;
    const nameMatch = /^metadata:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+name:[ \t]+(\S+)[ \t]*$/m.exec(chunk);
    if (!nameMatch) throw new Error('GitOps ingress document has no metadata.name');
    const rules = [];
    let current = null;
    for (const line of chunk.split(/\r?\n/)) {
      const host = /^    - host: (\S+)[ \t]*$/.exec(line);
      if (host) {
        current = { host: host[1], paths: [] };
        rules.push(current);
        continue;
      }
      if (!current) continue;
      const pathLine = /^          - path: (\S+)[ \t]*$/.exec(line);
      if (pathLine) {
        current.paths.push({ path: pathLine[1], pathType: null, backend: null, port: null });
        continue;
      }
      const last = current.paths[current.paths.length - 1];
      if (!last) continue;
      const typeLine = /^            pathType: (\S+)[ \t]*$/.exec(line);
      if (typeLine) { last.pathType = typeLine[1]; continue; }
      const backendLine = /^                name: (\S+)[ \t]*$/.exec(line);
      if (backendLine) { last.backend = backendLine[1]; continue; }
      const portLine = /^                  number: (\d+)[ \t]*$/.exec(line);
      if (portLine) { last.port = Number(portLine[1]); continue; }
    }
    if (rules.length === 0) throw new Error('GitOps ingress document has no rules');
    for (const rule of rules) {
      if (rule.paths.length !== 1) {
        throw new Error('Unsupported ingress structure: expected exactly one path per host rule');
      }
      const entry = rule.paths[0];
      if (!entry.pathType || !entry.backend || !Number.isInteger(entry.port)) {
        throw new Error('Unsupported ingress structure: incomplete path/backend declaration');
      }
    }
    documents.push({ name: nameMatch[1], rules });
  }
  return documents;
}

export function parseKustomizationResources(text) {
  if (typeof text !== 'string') throw new Error('GitOps kustomization readback missing');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^resources:[ \t]*$/.test(line));
  if (start < 0) return [];
  const resources = [];
  for (let i = start + 1; i < lines.length; i++) {
    const item = /^- (\S+)[ \t]*$/.exec(lines[i]);
    if (!item) break;
    resources.push(item[1]);
  }
  return resources;
}

// Deterministic render comparison against pinned GitOps state. A site may
// legitimately still declare its reviewed legacy alias while #4588 migrates
// hosts; anything else fails closed. DNS registration separately requires
// the canonical host (lanApplyReadiness).
export function compareGitops(registry, files) {
  validateRegistry(registry);
  const known = new Set();
  for (const site of registry.sites) {
    known.add(site.fqdn);
    if (site.legacyFqdn) known.add(site.legacyFqdn);
  }
  const parsed = new Map();
  const unknownHosts = [];
  const preservedLocalHosts = [];
  for (const [file, text] of Object.entries(files)) {
    let documents;
    try {
      documents = parseIngressDocuments(text);
    } catch (error) {
      throw new Error('GitOps comparison cannot parse ' + file + ': ' + error.message);
    }
    parsed.set(file, documents);
    for (const document of documents) {
      for (const rule of document.rules) {
        if (rule.host.endsWith('.nhome.local')) {
          preservedLocalHosts.push(rule.host);
        } else if (rule.host.endsWith('.' + ZONE)) {
          if (!known.has(rule.host) || rule.host.includes('*')) unknownHosts.push(rule.host);
        } else {
          unknownHosts.push(rule.host);
        }
      }
    }
  }
  const sites = registry.sites.map(site => {
    const documents = parsed.get(site.gitops.path);
    if (!documents) return { id: site.id, status: 'missing', reason: 'GitOps file not provided: ' + site.gitops.path };
    const document = documents.find(entry => entry.name === site.gitops.ingress);
    if (!document) return { id: site.id, status: 'missing', reason: 'Ingress object not found: ' + site.gitops.ingress };
    const zoneRules = document.rules.filter(rule => rule.host.endsWith('.' + ZONE));
    const hosts = zoneRules.map(rule => rule.host);
    const expectedHosts = [site.fqdn, site.legacyFqdn].filter(Boolean);
    const unexpected = hosts.filter(host => !expectedHosts.includes(host));
    let status = 'mismatch';
    let reason = null;
    if (unexpected.length > 0) {
      reason = 'unexpected zone hosts: ' + unexpected.join(', ');
    } else if (hosts.includes(site.fqdn)) {
      status = 'canonical';
    } else if (site.legacyFqdn && hosts.includes(site.legacyFqdn)) {
      status = 'legacy';
    } else {
      reason = 'neither canonical nor reviewed legacy host declared';
    }
    if (status !== 'mismatch') {
      for (const rule of zoneRules) {
        const entry = rule.paths[0];
        if (entry.backend !== site.backend.service || entry.port !== site.backend.port ||
            entry.path !== site.route.path || entry.pathType !== site.route.pathType) {
          status = 'mismatch';
          reason = 'backend/route identity differs from the reviewed registry';
          break;
        }
      }
    }
    if (site.gitops.kustomization) {
      const kustomization = files[site.gitops.kustomization];
      if (typeof kustomization !== 'string') {
        return { id: site.id, status: 'missing', reason: 'Kustomization not provided' };
      }
      const enrolled = parseKustomizationResources(kustomization).includes('ingress.yaml');
      if (enrolled !== site.enabled) {
        status = 'enrollment-drift';
        reason = 'ingress enrollment ' + (enrolled ? 'present' : 'absent') +
          ' but registry enabled=' + site.enabled;
      }
    }
    return { id: site.id, status, hosts, ...(reason ? { reason } : {}) };
  });
  const ok = unknownHosts.length === 0 &&
    sites.every(site => site.status === 'canonical' || site.status === 'legacy');
  return { ok, sites, unknownHosts, preservedLocalHosts: [...new Set(preservedLocalHosts)].sort() };
}

export function lanApplyReadiness(comparison, siteId) {
  const site = comparison.sites.find(entry => entry.id === siteId);
  return Boolean(site && site.status === 'canonical');
}

// Sanitized receipt binding. Hashes cover full provider state (including
// secret values) but the receipt itself never carries those values.
export function hashObservedState(provider, observation) {
  return sha256Hex(canonicalJson({ provider, observation }));
}

export function buildPlanReceipt({
  provider, mode, environment, site, sourceSha, gitopsRevision,
  registryHash: hash, operations, observedState, desiredState, runId, runAttempt
}) {
  if (!SHA256.test(hash ?? '')) throw new Error('Plan receipt requires the registry content hash');
  if (typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('Plan receipt requires the exact 40-hex source SHA');
  }
  if (typeof gitopsRevision !== 'string' || !/^[0-9a-f]{40}$/.test(gitopsRevision)) {
    throw new Error('Plan receipt requires the exact 40-hex GitOps revision');
  }
  const observedHash = hashObservedState(provider, observedState);
  const desiredHash = hashObservedState(provider + ':desired', desiredState);
  return {
    receipt: 'NESSION_SITE_PLAN_V1',
    provider, mode, environment, site,
    sourceSha, gitopsRevision, registryHash: hash,
    operations, observedHash, desiredHash,
    planHash: sha256Hex(canonicalJson({
      provider, environment, site, sourceSha, gitopsRevision,
      registryHash: hash, operations, observedHash, desiredHash
    })),
    runId: String(runId ?? ''), runAttempt: String(runAttempt ?? ''),
    createdAt: new Date().toISOString()
  };
}

export function verifyPlanReceipt(receipt, {
  provider, environment, site, sourceSha, gitopsRevision,
  registryHash: hash, observedState, desiredState
}) {
  const mismatch = reason => {
    throw new Error('Stale or mismatched site plan rejected: ' + reason);
  };
  if (!receipt || receipt.receipt !== 'NESSION_SITE_PLAN_V1') mismatch('missing plan receipt');
  if (receipt.provider !== provider) mismatch('provider identity');
  if (receipt.environment !== environment) mismatch('environment identity');
  if (receipt.site !== site) mismatch('site identity');
  if (receipt.sourceSha !== sourceSha) mismatch('source SHA changed since plan');
  if (receipt.gitopsRevision !== gitopsRevision) mismatch('GitOps revision changed since plan');
  if (receipt.registryHash !== hash) mismatch('registry changed since plan');
  if (receipt.observedHash !== hashObservedState(provider, observedState)) {
    mismatch('provider state changed since plan');
  }
  if (receipt.desiredHash !== hashObservedState(provider + ':desired', desiredState)) {
    mismatch('desired state changed since plan (re-plan and re-approve)');
  }
  return true;
}

function readGitopsFiles(dir, registry) {
  const files = {};
  const paths = new Set();
  for (const site of registry.sites) {
    paths.add(site.gitops.path);
    if (site.gitops.kustomization) paths.add(site.gitops.kustomization);
  }
  for (const relative of paths) {
    const full = path.join(dir, relative);
    if (!fs.existsSync(full)) throw new Error('Pinned GitOps checkout is missing ' + relative);
    files[relative] = fs.readFileSync(full, 'utf8');
  }
  return files;
}

function cli() {
  const [command] = process.argv.slice(2);
  const { registry, approvals, registryHash: hash } = loadRegistry();
  if (command === 'validate') {
    console.log('SITE_REGISTRY_VALID_V1 sites=' + registry.sites.length +
      ' public=' + registry.publicAllowlist.length + ' registry_hash=' + hash);
    return;
  }
  if (command === 'render-lan') {
    const plan = renderLanPlan(registry, process.env.LAN_GATEWAY_IP);
    const out = process.env.SITE_PLAN_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
    console.log('SITE_LAN_PLAN_V1 sites=' + plan.length + ' answer_ref=' + LAN_ANSWER_REF +
      ' domains=' + plan.map(entry => entry.domain).join(','));
    return;
  }
  if (command === 'render-public') {
    const plan = renderPublicPlan(registry);
    console.log('SITE_PUBLIC_PLAN_V1 ' + JSON.stringify(plan));
    return;
  }
  if (command === 'compare') {
    const dir = process.env.GITOPS_CHECKOUT;
    if (!dir || !path.isAbsolute(dir)) throw new Error('GITOPS_CHECKOUT must be an absolute pinned checkout path');
    const report = compareGitops(registry, readGitopsFiles(dir, registry));
    console.log('SITE_GITOPS_COMPARISON_V1 ' + JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'approvals') {
    console.log('SITE_APPROVALS_V1 entries=' + approvals.approvals.length);
    return;
  }
  if (command === 'lan-readiness') {
    const reportFile = process.env.SITE_COMPARISON_REPORT;
    if (!reportFile) throw new Error('SITE_COMPARISON_REPORT must reference the pinned GitOps comparison report');
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const selection = process.env.SITE_SELECTION || 'all';
    const reconcile = process.env.TARGET_ACTION === 'reconcile';
    const selected = registry.sites.filter(site =>
      site.enabled && (selection === 'all' || site.id === selection));
    const ready = [];
    const pending = [];
    for (const site of selected) {
      if (lanApplyReadiness(report, site.id)) ready.push(site.id);
      else pending.push(site.id);
    }
    console.log('SITE_LAN_READINESS_V1 ready=' + ready.length + ' pending_migration=' + pending.length +
      (pending.length ? ' sites=' + pending.join(',') : ''));
    if (process.env.SITE_READY_OUT) {
      fs.writeFileSync(process.env.SITE_READY_OUT, JSON.stringify(ready) + '\n', { mode: 0o600 });
    }
    if (pending.length > 0 && !reconcile) {
      console.error('LAN DNS registration requires canonical GitOps hosts (#4588 migration) for: ' + pending.join(', '));
      process.exitCode = 1;
    }
    return;
  }
  throw new Error('usage: site-registry.mjs <validate|render-lan|render-public|compare|approvals|lan-readiness>');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    cli();
  } catch (error) {
    console.error('Site registry operation failed: ' + error.message);
    process.exitCode = 1;
  }
}

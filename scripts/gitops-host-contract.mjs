#!/usr/bin/env node
// Owner: #4588 SC-01 — the rendered GitOps hostname/config contract for Nession.
//
// The `gitops` orphan branch is the deployment-state owner. This checker reads
// a checkout of that branch (or a fixture tree) and proves that every managed
// environment renders:
//
//   - the canonical single-label `bestnathan.top` host for each existing
//     Server/Agent/UI service, with the correct environment backend
//     (nameSuffix-renamed service + port) and an exact `higress.io/domain`
//     annotation matching the rendered host set;
//   - the preserved `nhome.local` hosts verbatim (LAN HTTP behavior unchanged);
//   - only canonical or known legacy-nested bestnathan.top hosts (no foreign
//     zone, no partial-label wildcard, no multi-label canonical name);
//   - the canonical HTTPS browser origins and canonical WSS advertised agent
//     endpoint in the rendered deployment config, with nhome.local preserved;
//   - the staging MCP endpoint enrolled with its canonical host and exact /mcp
//     path, the production MCP ingress present but DORMANT (not enrolled), and
//     no MCP service created in the staging-01/preprod dormant lanes.
//
// It does not read a cluster, apply anything, activate DNS, or change TLS.
// Certificate ownership / readiness / retirement is owned by
// scripts/gitops-tls-contract.mjs (#4588 SC-03). The YAML subset parser is
// shared with scripts/gitops-storage-contract.mjs (one parser owner).
import fs from 'node:fs';
import path from 'node:path';
import { parseYamlDocuments } from './gitops-storage-contract.mjs';

const ZONE = 'bestnathan.top';
const LAN_ZONE = 'nhome.local';
const MANAGED = ['production', 'staging', 'staging-01', 'preprod'];
const ROLES = { server: 10080, agent: 10080, ui: 80 };

// Canonical naming: `env-service-nession`, production omits env and the server
// service prefix. Exactly one label before the zone suffix.
const ENV_META = {
  production: { suffix: '', prefix: '', dot: '' },
  staging: { suffix: '-staging', prefix: 'staging-', dot: 'staging.' },
  'staging-01': { suffix: '-staging-01', prefix: 'staging-01-', dot: 'staging-01.' },
  preprod: { suffix: '-preprod', prefix: 'preprod-', dot: 'preprod.' },
};

function fail(message) {
  throw new Error(message);
}

function canonicalHost(environment, role) {
  const { prefix } = ENV_META[environment];
  const label = role === 'server' ? `${prefix}nession` : `${prefix}${role}-nession`;
  return `${label}.${ZONE}`;
}

// Legacy nested names retained as LAN compatibility during migration; retired
// only after cutover readback (#4588 / #4589). Production server's legacy name
// is already the canonical single-label name.
function legacyHost(environment, role) {
  const { dot } = ENV_META[environment];
  const label = role === 'server' ? `${dot}nession` : `${dot}${role}.nession`;
  return `${label}.${ZONE}`;
}

// nhome.local hosts are preserved verbatim — never renamed, never removed.
function lanHost(environment, role) {
  const { dot } = ENV_META[environment];
  const label = role === 'server' ? `${dot}nession` : `${dot}${role}.nession`;
  return `${label}.${LAN_ZONE}`;
}

function readTreeFile(root, relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) fail('missing GitOps file: ' + relative);
  return fs.readFileSync(full, 'utf8');
}

function optionalTreeFile(root, relative) {
  const full = path.join(root, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function documents(text, relative) {
  const docs = parseYamlDocuments(text);
  if (!docs.length) fail(relative + ': no YAML documents');
  return docs;
}

function overlayMeta(root, environment) {
  const relative = `environments/${environment}/nession/kustomization.yaml`;
  const [overlay] = documents(readTreeFile(root, relative), relative);
  if (!overlay || overlay.kind !== 'Kustomization') fail(relative + ': not a Kustomization');
  const suffix = String(overlay.nameSuffix ?? '');
  const expected = ENV_META[environment].suffix;
  if (suffix !== expected) {
    fail(`${relative}: nameSuffix ${JSON.stringify(suffix)} != expected ${JSON.stringify(expected)}`);
  }
  return { suffix, resources: Array.isArray(overlay.resources) ? overlay.resources.map(String) : [] };
}

// Render one environment's ingress for a role: base rules replaced wholesale by
// the overlay patch rules (kustomize strategic-merge on an unkeyed list),
// annotations merged per key, backend service names renamed by nameSuffix.
function renderIngress(root, environment, role) {
  const baseRelative = `base/nession/ingress-${role}.yaml`;
  const [base] = documents(readTreeFile(root, baseRelative), baseRelative);
  if (!base || base.kind !== 'Ingress') fail(baseRelative + ': not an Ingress');
  const { suffix } = overlayMeta(root, environment);
  const annotations = { ...(base.metadata?.annotations ?? {}) };
  let rules = base.spec?.rules ?? [];
  const patchRelative = `environments/${environment}/nession/patch-ingress.yaml`;
  const patchText = optionalTreeFile(root, patchRelative);
  if (patchText !== null) {
    for (const patch of documents(patchText, patchRelative)) {
      if (patch.kind !== 'Ingress' || patch.metadata?.name !== `nession-${role}`) continue;
      Object.assign(annotations, patch.metadata?.annotations ?? {});
      if (Array.isArray(patch.spec?.rules)) rules = patch.spec.rules;
    }
  }
  const rendered = rules.map((rule) => {
    const paths = rule?.http?.paths ?? [];
    return {
      host: String(rule?.host ?? ''),
      paths: paths.map((p) => ({
        path: String(p?.path ?? ''),
        pathType: String(p?.pathType ?? ''),
        service: String(p?.backend?.service?.name ?? '') + suffix,
        port: String(p?.backend?.service?.port?.number ?? ''),
      })),
    };
  });
  return {
    name: String(base.metadata?.name ?? '') + suffix,
    ingressClassName: String(base.spec?.ingressClassName ?? ''),
    annotations,
    rules: rendered,
    hosts: rendered.map((r) => r.host),
  };
}

// Merge a deployment env var: base value, overridden by the environment patch
// (kustomize strategic-merge merges the env list by name).
function deploymentEnv(root, environment, role, name) {
  const readEnv = (text, relative) => {
    if (text === null) return undefined;
    const [doc] = documents(text, relative);
    const containers = doc?.spec?.template?.spec?.containers ?? [];
    for (const container of containers) {
      for (const entry of container?.env ?? []) {
        if (entry?.name === name) return String(entry.value ?? '');
      }
    }
    return undefined;
  };
  const base = readEnv(
    optionalTreeFile(root, `base/nession/deployment-${role}.yaml`),
    `base/nession/deployment-${role}.yaml`,
  );
  const patch = readEnv(
    optionalTreeFile(root, `environments/${environment}/nession/patch-${role}-env.yaml`),
    `environments/${environment}/nession/patch-${role}-env.yaml`,
  );
  return patch !== undefined ? patch : base;
}

function splitList(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function isSingleLabelCanonical(host) {
  return host.endsWith('.' + ZONE) &&
    host.slice(0, -(ZONE.length + 1)).length > 0 &&
    !host.slice(0, -(ZONE.length + 1)).includes('.');
}

function ingressContract(root, environment, role, errors) {
  const ingress = renderIngress(root, environment, role);
  const expectedCanonical = canonicalHost(environment, role);
  const expectedLegacy = legacyHost(environment, role);
  const expectedLan = lanHost(environment, role);
  const { suffix } = ENV_META[environment];
  const where = `${environment}/${role}`;

  if (ingress.ingressClassName !== 'higress') {
    errors.push(`${where}: ingressClassName must be higress`);
  }
  if (!ingress.hosts.includes(expectedCanonical)) {
    errors.push(`${where}: missing canonical host ${expectedCanonical}`);
  }
  if (!isSingleLabelCanonical(expectedCanonical)) {
    errors.push(`${where}: canonical host ${expectedCanonical} is not single-label`);
  }
  // nhome.local preserved verbatim: exactly the one expected LAN host.
  const lanHosts = ingress.hosts.filter((h) => h.endsWith('.' + LAN_ZONE));
  if (lanHosts.length !== 1 || lanHosts[0] !== expectedLan) {
    errors.push(`${where}: nhome.local hosts ${JSON.stringify(lanHosts)} != preserved [${expectedLan}]`);
  }
  // Every host is the canonical name, the known legacy nested name, or the
  // preserved LAN host — no foreign zone, no unknown bestnathan.top name.
  for (const host of ingress.hosts) {
    if (host === expectedCanonical || host === expectedLegacy || host === expectedLan) continue;
    errors.push(`${where}: unexpected host ${host} (not canonical/legacy/nhome.local)`);
  }
  // Backend identity: every rule routes to this environment's own service/port.
  const expectedService = `nession-${role}${suffix}`;
  const expectedPort = String(ROLES[role]);
  for (const rule of ingress.rules) {
    for (const p of rule.paths) {
      if (p.path !== '/' || p.pathType !== 'Prefix') {
        errors.push(`${where}: host ${rule.host} path ${p.path}/${p.pathType} != / Prefix`);
      }
      if (p.service !== expectedService || p.port !== expectedPort) {
        errors.push(`${where}: host ${rule.host} backend ${p.service}:${p.port} != ${expectedService}:${expectedPort}`);
      }
    }
  }
  // higress.io/domain must name exactly the rendered host set.
  const domain = splitList(String(ingress.annotations['higress.io/domain'] ?? '').replace(/ /g, ','));
  const hostSet = new Set(ingress.hosts);
  const domainSet = new Set(domain);
  if (domainSet.size !== hostSet.size || [...hostSet].some((h) => !domainSet.has(h))) {
    errors.push(`${where}: higress.io/domain ${JSON.stringify(domain)} != hosts ${JSON.stringify(ingress.hosts)}`);
  }
  return ingress;
}

function configContract(root, environment, errors) {
  const where = `${environment}/config`;
  const origins = splitList(deploymentEnv(root, environment, 'server', 'SERVER_ALLOWED_ORIGINS'));
  // Canonical HTTPS origins for the server and UI hosts (the new names are
  // HTTPS-only at the actual TLS edge); nhome.local HTTP origins preserved.
  for (const role of ['server', 'ui']) {
    const httpsOrigin = `https://${canonicalHost(environment, role)}`;
    if (!origins.includes(httpsOrigin)) {
      errors.push(`${where}: SERVER_ALLOWED_ORIGINS missing canonical ${httpsOrigin}`);
    }
  }
  for (const role of ['server', 'ui']) {
    const lanOrigin = `http://${lanHost(environment, role)}`;
    if (!origins.includes(lanOrigin)) {
      errors.push(`${where}: SERVER_ALLOWED_ORIGINS dropped preserved ${lanOrigin}`);
    }
  }
  // No cleartext origin for a canonical host that is not already a legacy
  // nested name: the migration must not widen trust to a secure downgrade.
  for (const origin of origins) {
    if (!origin.startsWith('http://')) continue;
    const host = origin.slice('http://'.length);
    if (host.endsWith('.' + ZONE) && isSingleLabelCanonical(host) &&
        host !== legacyHost(environment, 'server')) {
      errors.push(`${where}: cleartext canonical origin ${origin} downgrades secure transport`);
    }
  }
  // Canonical WSS advertised agent endpoint; legacy nhome.local connect_url kept.
  const advertise = splitList(deploymentEnv(root, environment, 'agent', 'AGENT_ADVERTISE_URLS'));
  const wss = `wss://${canonicalHost(environment, 'agent')}/ws`;
  if (!advertise.includes(wss)) {
    errors.push(`${where}: AGENT_ADVERTISE_URLS missing canonical ${wss}`);
  }
  const connectUrl = deploymentEnv(root, environment, 'agent', 'AGENT_CONNECT_URL');
  const expectedConnect = `ws://${lanHost(environment, 'agent')}/ws`;
  if (connectUrl !== expectedConnect) {
    errors.push(`${where}: AGENT_CONNECT_URL ${JSON.stringify(connectUrl)} != preserved ${expectedConnect}`);
  }
}

function mcpContract(root, errors) {
  // staging MCP: enrolled, canonical host, exact /mcp, correct backend.
  const stagingDir = 'environments/staging/mcp';
  const stagingKustomization = `${stagingDir}/kustomization.yaml`;
  const [stagingOverlay] = documents(readTreeFile(root, stagingKustomization), stagingKustomization);
  const stagingResources = (stagingOverlay.resources ?? []).map(String);
  if (!stagingResources.includes('ingress.yaml')) {
    errors.push('staging/mcp: ingress.yaml must be enrolled (active canonical MCP endpoint)');
  }
  const [stagingIngress] = documents(readTreeFile(root, `${stagingDir}/ingress.yaml`), `${stagingDir}/ingress.yaml`);
  checkMcpIngress(stagingIngress, 'staging-mcp-nession.bestnathan.top', 'nession-mcp-staging', 'staging/mcp', errors);

  // production MCP: manifest present with the canonical host, but DORMANT —
  // not enrolled until #4529 prerequisites and the operational gate are met.
  const prodDir = 'environments/production/mcp';
  const prodKustomization = `${prodDir}/kustomization.yaml`;
  const [prodOverlay] = documents(readTreeFile(root, prodKustomization), prodKustomization);
  const prodResources = (prodOverlay.resources ?? []).map(String);
  const [prodIngress] = documents(readTreeFile(root, `${prodDir}/ingress.yaml`), `${prodDir}/ingress.yaml`);
  checkMcpIngress(prodIngress, 'mcp-nession.bestnathan.top', 'nession-mcp-production', 'production/mcp', errors);
  if (prodResources.includes('ingress.yaml')) {
    errors.push('production/mcp: ingress.yaml is enrolled — dormant pilot must not activate here');
  }

  // Dormant lanes must not gain an MCP service.
  for (const environment of ['staging-01', 'preprod']) {
    if (fs.existsSync(path.join(root, `environments/${environment}/mcp`))) {
      errors.push(`${environment}/mcp: dormant lane must not create an MCP service`);
    }
  }
}

function checkMcpIngress(ingress, host, service, where, errors) {
  if (!ingress || ingress.kind !== 'Ingress') {
    errors.push(`${where}: missing MCP Ingress`);
    return;
  }
  const rules = ingress.spec?.rules ?? [];
  const hosts = rules.map((r) => String(r?.host ?? ''));
  if (hosts.length !== 1 || hosts[0] !== host) {
    errors.push(`${where}: MCP hosts ${JSON.stringify(hosts)} != [${host}]`);
  }
  if (!isSingleLabelCanonical(host)) {
    errors.push(`${where}: MCP host ${host} is not single-label canonical`);
  }
  for (const rule of rules) {
    for (const p of rule?.http?.paths ?? []) {
      if (String(p?.path ?? '') !== '/mcp' || String(p?.pathType ?? '') !== 'Exact') {
        errors.push(`${where}: MCP path ${p?.path}/${p?.pathType} != /mcp Exact`);
      }
      if (String(p?.backend?.service?.name ?? '') !== service ||
          String(p?.backend?.service?.port?.number ?? '') !== '9090') {
        errors.push(`${where}: MCP backend != ${service}:9090`);
      }
    }
  }
}

export function checkGitOpsHosts(root) {
  const errors = [];
  const lines = [];
  for (const environment of MANAGED) {
    const dir = path.join(root, 'environments', environment, 'nession');
    if (!fs.existsSync(dir)) fail('missing managed environment: ' + environment);
    for (const role of Object.keys(ROLES)) {
      const ingress = ingressContract(root, environment, role, errors);
      lines.push(`${environment}/${role}: hosts ${ingress.hosts.join(' ')}`);
    }
    configContract(root, environment, errors);
  }
  mcpContract(root, errors);
  return { environments: MANAGED, lines, errors };
}

// ---------------------------------------------------------------------------
// Fixtures: a real-shaped tree generated from the contract, then mutated. Each
// regression starts from the valid baseline so a detector gap is one edit away.
// ---------------------------------------------------------------------------
function ingressYaml(environment, role, { hosts, service, port, domain }) {
  const rules = hosts.map((host) => `    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${service}
                port:
                  number: ${port}`).join('\n');
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nession-${role}
  annotations:
    higress.io/domain: "${domain}"
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
spec:
  ingressClassName: higress
  rules:
${rules}
`;
}

function baseIngressYaml(role) {
  const hosts = [
    lanHost('production', role),
    legacyHost('production', role),
    canonicalHost('production', role),
  ];
  const unique = [...new Set(hosts)];
  return ingressYaml('production', role, {
    hosts: unique,
    service: `nession-${role}`,
    port: ROLES[role],
    domain: unique.join(' '),
  });
}

function patchIngressYaml(environment) {
  return Object.keys(ROLES).map((role) => {
    const hosts = [lanHost(environment, role), legacyHost(environment, role), canonicalHost(environment, role)];
    const unique = [...new Set(hosts)];
    return ingressYaml(environment, role, {
      hosts: unique,
      service: `nession-${role}`,
      port: ROLES[role],
      domain: unique.join(' '),
    });
  }).join('---\n');
}

function deploymentYaml(role, envEntries) {
  const env = envEntries.map(([name, value]) => `            - name: ${name}
              value: "${value}"`).join('\n');
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: nession-${role}
spec:
  template:
    spec:
      containers:
        - name: nession-${role}
          env:
${env}
`;
}

function originsValue(environment) {
  const entries = [];
  for (const role of ['server', 'ui']) {
    entries.push(`http://${lanHost(environment, role)}`);
    entries.push(`http://${legacyHost(environment, role)}`);
    entries.push(`https://${legacyHost(environment, role)}`);
    entries.push(`https://${canonicalHost(environment, role)}`);
  }
  return [...new Set(entries)].join(',');
}

function mcpIngressYaml(host, service) {
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${service}
  annotations:
    higress.io/domain: "${host}"
spec:
  ingressClassName: higress
  rules:
    - host: ${host}
      http:
        paths:
          - path: /mcp
            pathType: Exact
            backend:
              service:
                name: ${service}
                port:
                  number: 9090
`;
}

function fixtureTree() {
  const tree = {};
  for (const role of Object.keys(ROLES)) {
    tree[`base/nession/ingress-${role}.yaml`] = baseIngressYaml(role);
  }
  tree['base/nession/deployment-agent.yaml'] = deploymentYaml('agent', [
    ['AGENT_CONNECT_URL', 'ws://agent.nession.nhome.local/ws'],
    ['AGENT_ADVERTISE_URLS', 'wss://agent-nession.bestnathan.top/ws'],
  ]);
  tree['base/nession/deployment-server.yaml'] = deploymentYaml('server', []);
  for (const environment of MANAGED) {
    const { suffix } = ENV_META[environment];
    tree[`environments/${environment}/nession/kustomization.yaml`] =
      `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: nession
${suffix ? 'nameSuffix: ' + suffix + '\n' : ''}resources:
- ../../base/nession
${environment === 'production' ? '' : '- patch-ingress.yaml\n'}patchesStrategicMerge:
- patch-server-env.yaml
`;
    if (environment !== 'production') {
      tree[`environments/${environment}/nession/patch-ingress.yaml`] = patchIngressYaml(environment);
      tree[`environments/${environment}/nession/patch-agent-env.yaml`] = deploymentYaml('agent', [
        ['AGENT_CONNECT_URL', `ws://${lanHost(environment, 'agent')}/ws`],
        ['AGENT_ADVERTISE_URLS', `wss://${canonicalHost(environment, 'agent')}/ws`],
      ]);
    }
    tree[`environments/${environment}/nession/patch-server-env.yaml`] = deploymentYaml('server', [
      ['SERVER_ALLOWED_ORIGINS', originsValue(environment)],
    ]);
  }
  tree['environments/staging/mcp/kustomization.yaml'] =
    `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: nession
resources:
- ingress.yaml
- service.yaml
`;
  tree['environments/staging/mcp/ingress.yaml'] =
    mcpIngressYaml('staging-mcp-nession.bestnathan.top', 'nession-mcp-staging');
  tree['environments/production/mcp/kustomization.yaml'] =
    `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: nession
resources:
- deployment.yaml
- service.yaml
`;
  tree['environments/production/mcp/ingress.yaml'] =
    mcpIngressYaml('mcp-nession.bestnathan.top', 'nession-mcp-production');
  return tree;
}

function writeTree(root, tree) {
  for (const [relative, text] of Object.entries(tree)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

export function selfTest() {
  const os = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'gitops-host-contract-'));
  const cases = [];
  const run = (name, mutate, expectReject) => {
    const root = path.join(os, name.replace(/[^a-z0-9]+/gi, '-'));
    const tree = fixtureTree();
    if (mutate) mutate(tree);
    writeTree(root, tree);
    let errors = [];
    try {
      errors = checkGitOpsHosts(root).errors;
    } catch (error) {
      errors = [error.message];
    }
    const rejected = errors.length > 0;
    if (rejected !== expectReject) {
      fail(`self-test ${name}: expected ${expectReject ? 'rejection' : 'acceptance'}, got ${JSON.stringify(errors)}`);
    }
    cases.push(name);
    fs.rmSync(root, { recursive: true, force: true });
  };

  run('baseline', null, false);
  run('missing-canonical-host', (tree) => {
    tree['environments/staging/nession/patch-ingress.yaml'] =
      tree['environments/staging/nession/patch-ingress.yaml']
        .replace('staging-nession.bestnathan.top', 'staging.nession.bestnathan.top');
  }, true);
  run('multi-label-canonical', (tree) => {
    tree['base/nession/ingress-agent.yaml'] =
      tree['base/nession/ingress-agent.yaml']
        .replace('agent-nession.bestnathan.top', 'agent.nession.bestnathan.top');
  }, true);
  run('wrong-backend-port', (tree) => {
    tree['base/nession/ingress-ui.yaml'] =
      tree['base/nession/ingress-ui.yaml'].replace('number: 80', 'number: 8080');
  }, true);
  run('wrong-backend-service', (tree) => {
    tree['environments/staging/nession/patch-ingress.yaml'] =
      tree['environments/staging/nession/patch-ingress.yaml']
        .replace('name: nession-server', 'name: nession-server-staging');
  }, true);
  run('nhome-local-removed', (tree) => {
    tree['base/nession/ingress-server.yaml'] =
      tree['base/nession/ingress-server.yaml']
        .replace(/    - host: nession\.nhome\.local\n(?:.*\n)*?                  number: 10080\n/, '');
  }, true);
  run('foreign-zone-host', (tree) => {
    tree['base/nession/ingress-server.yaml'] =
      tree['base/nession/ingress-server.yaml']
        .replace('nession.bestnathan.top', 'nession.evil.example');
  }, true);
  run('domain-annotation-mismatch', (tree) => {
    tree['base/nession/ingress-ui.yaml'] =
      tree['base/nession/ingress-ui.yaml']
        .replace('higress.io/domain: "ui.nession.nhome.local ui.nession.bestnathan.top ui-nession.bestnathan.top"',
          'higress.io/domain: "ui.nession.nhome.local"');
  }, true);
  run('production-mcp-enrolled', (tree) => {
    tree['environments/production/mcp/kustomization.yaml'] =
      tree['environments/production/mcp/kustomization.yaml'].replace('- service.yaml', '- service.yaml\n- ingress.yaml');
  }, true);
  run('dormant-lane-mcp-created', (tree) => {
    tree['environments/preprod/mcp/kustomization.yaml'] = 'kind: Kustomization\n';
  }, true);
  run('staging-mcp-path-not-exact', (tree) => {
    tree['environments/staging/mcp/ingress.yaml'] =
      tree['environments/staging/mcp/ingress.yaml'].replace('pathType: Exact', 'pathType: Prefix');
  }, true);
  run('missing-canonical-https-origin', (tree) => {
    tree['environments/staging/nession/patch-server-env.yaml'] =
      tree['environments/staging/nession/patch-server-env.yaml']
        .replace('https://staging-ui-nession.bestnathan.top', 'https://staging.ui.nession.bestnathan.top');
  }, true);
  run('cleartext-canonical-origin', (tree) => {
    tree['environments/production/nession/patch-server-env.yaml'] =
      tree['environments/production/nession/patch-server-env.yaml']
        .replace('https://ui-nession.bestnathan.top', 'http://ui-nession.bestnathan.top');
  }, true);
  run('nhome-local-origin-dropped', (tree) => {
    tree['environments/staging/nession/patch-server-env.yaml'] =
      tree['environments/staging/nession/patch-server-env.yaml']
        .replace('http://staging.nession.nhome.local,', '');
  }, true);
  run('missing-canonical-wss-advertise', (tree) => {
    tree['environments/staging/nession/patch-agent-env.yaml'] =
      tree['environments/staging/nession/patch-agent-env.yaml']
        .replace('wss://staging-agent-nession.bestnathan.top/ws', 'wss://staging.agent.nession.bestnathan.top/ws');
  }, true);
  run('nhome-local-connect-url-changed', (tree) => {
    tree['base/nession/deployment-agent.yaml'] =
      tree['base/nession/deployment-agent.yaml']
        .replace('ws://agent.nession.nhome.local/ws', 'wss://agent-nession.bestnathan.top/ws');
  }, true);

  fs.rmSync(os, { recursive: true, force: true });
  return `gitops-host-contract self-test: baseline accepted and ${cases.length - 1} regressions rejected`;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    console.log(selfTest());
    return;
  }
  let root = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') {
      root = args[index + 1];
      index += 1;
    } else {
      fail('unknown argument: ' + args[index]);
    }
  }
  if (!root) fail('usage: gitops-host-contract.mjs --root <gitops-checkout> | --self-test');
  const result = checkGitOpsHosts(root);
  for (const line of result.lines) console.log(line);
  if (result.errors.length) {
    for (const error of result.errors) console.error('gitops-host-contract: ' + error);
    process.exitCode = 1;
    return;
  }
  console.log('gitops-host-contract: ' + result.environments.length +
    ' environments render canonical single-label hosts, preserved nhome.local, dormant MCP inactive');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error('gitops-host-contract: ' + (error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}

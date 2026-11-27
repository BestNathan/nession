#!/usr/bin/env node
// Deterministic contract tests for the reviewed site registry (#4589 SC-01,
// parts of SC-03/SC-04/SC-05). Negative fixtures prove each rejection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRegistry, validateRegistry, validateApprovals, findApproval,
  expectedHostLabel, renderLanPlan, renderPublicPlan, compareGitops,
  lanApplyReadiness, parseIngressDocuments, parseKustomizationResources,
  canonicalJson, sha256Hex, registryHash, hashObservedState,
  buildPlanReceipt, verifyPlanReceipt, validateGatewayIpv4,
  SENSITIVE_OPERATIONS, ZONE
} from './site-registry.mjs';

const loaded = loadRegistry();
const registry = loaded.registry;
const gateway = '192.168.2.10';
const sourceSha = '1'.repeat(40);
const gitopsRevision = '2'.repeat(40);

function clone(value) {
  return structuredClone(value);
}

function ingressDoc({ name, rules }) {
  const lines = [
    'apiVersion: networking.k8s.io/v1',
    'kind: Ingress',
    'metadata:',
    '  name: ' + name,
    '  annotations:',
    '    higress.io/domain: "' + rules.map(rule => rule.host).join(' ') + '"',
    'spec:',
    '  ingressClassName: higress',
    '  rules:'
  ];
  for (const rule of rules) {
    lines.push(
      '    - host: ' + rule.host,
      '      http:',
      '        paths:',
      '          - path: ' + (rule.path ?? '/'),
      '            pathType: ' + (rule.pathType ?? 'Prefix'),
      '            backend:',
      '              service:',
      '                name: ' + rule.backend,
      '                port:',
      '                  number: ' + rule.port
    );
  }
  return lines.join('\n') + '\n';
}

function rule(host, backend, port, extra = {}) {
  return { host, backend, port, ...extra };
}

function kustomization(resources) {
  return 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n' +
    resources.map(entry => '- ' + entry).join('\n') + '\n';
}

// Current pre-migration GitOps shape: nested legacy bestnathan.top hosts plus
// preserved nhome.local rules; production keeps the unsuffixed base hosts.
function legacyGitopsFiles() {
  const files = {};
  const nested = {
    staging: 'staging', 'staging-01': 'staging-01', preprod: 'preprod'
  };
  for (const [env, prefix] of Object.entries(nested)) {
    const path = 'environments/' + env + '/nession/patch-ingress.yaml';
    files[path] = ['staging-server', 'staging-agent', 'staging-ui'].map((_, index) => {
      const service = ['server', 'agent', 'ui'][index];
      const port = service === 'ui' ? 80 : 10080;
      const localPrefix = service === 'server' ? '' : service + '.';
      return ingressDoc({
        name: 'nession-' + service,
        rules: [
          rule(prefix + '.' + localPrefix + 'nession.nhome.local', 'nession-' + service, port),
          rule(prefix + '.' + localPrefix + 'nession.bestnathan.top', 'nession-' + service, port)
        ]
      });
    }).join('---\n');
  }
  files['base/nession/ingress-server.yaml'] = ingressDoc({
    name: 'nession-server',
    rules: [
      rule('nession.nhome.local', 'nession-server', 10080),
      rule('nession.bestnathan.top', 'nession-server', 10080)
    ]
  });
  files['base/nession/ingress-agent.yaml'] = ingressDoc({
    name: 'nession-agent',
    rules: [
      rule('agent.nession.nhome.local', 'nession-agent', 10080),
      rule('agent.nession.bestnathan.top', 'nession-agent', 10080)
    ]
  });
  files['base/nession/ingress-ui.yaml'] = ingressDoc({
    name: 'nession-ui',
    rules: [
      rule('ui.nession.nhome.local', 'nession-ui', 80),
      rule('ui.nession.bestnathan.top', 'nession-ui', 80)
    ]
  });
  files['environments/staging/mcp/ingress.yaml'] = ingressDoc({
    name: 'nession-mcp-staging',
    rules: [rule('staging-mcp-nession.bestnathan.top', 'nession-mcp-staging', 9090,
      { path: '/mcp', pathType: 'Exact' })]
  });
  files['environments/staging/mcp/kustomization.yaml'] =
    kustomization(['deployment.yaml', 'service.yaml', 'ingress.yaml']);
  files['environments/production/mcp/ingress.yaml'] = ingressDoc({
    name: 'nession-mcp-production',
    rules: [rule('mcp-nession.bestnathan.top', 'nession-mcp-production', 9090,
      { path: '/mcp', pathType: 'Exact' })]
  });
  files['environments/production/mcp/kustomization.yaml'] =
    kustomization(['deployment.yaml', 'service.yaml']);
  return files;
}

// Post-#4588 canonical shape used to prove the migration target comparison.
function canonicalGitopsFiles() {
  const files = legacyGitopsFiles();
  for (const site of registry.sites) {
    if (!site.legacyFqdn) continue;
    const text = files[site.gitops.path];
    files[site.gitops.path] = text.replaceAll(site.legacyFqdn, site.fqdn);
  }
  return files;
}

test('checked-in registry validates and freezes the reviewed contract', () => {
  assert.equal(registry.sites.length, 14);
  assert.deepEqual(registry.publicAllowlist, ['staging-mcp', 'production-mcp']);
  assert.equal(registry.zone, ZONE);
  assert.equal(loaded.registryHash, registryHash(registry));
  assert.equal(loaded.registryHash, sha256Hex(canonicalJson(registry)));
  for (const site of registry.sites) {
    assert.equal(site.fqdn, expectedHostLabel(site.environment, site.service) + '.' + ZONE);
    assert.equal(site.visibility === 'public', site.service === 'mcp');
  }
  assert.equal(registry.sites.find(site => site.id === 'production-mcp').enabled, false);
  assert.equal(registry.sites.find(site => site.id === 'staging-mcp').enabled, true);
});

test('naming formula omits production env and server service prefix only', () => {
  assert.equal(expectedHostLabel('production', 'server'), 'nession');
  assert.equal(expectedHostLabel('production', 'agent'), 'agent-nession');
  assert.equal(expectedHostLabel('production', 'ui'), 'ui-nession');
  assert.equal(expectedHostLabel('production', 'mcp'), 'mcp-nession');
  assert.equal(expectedHostLabel('staging', 'server'), 'staging-nession');
  assert.equal(expectedHostLabel('staging', 'mcp'), 'staging-mcp-nession');
  assert.equal(expectedHostLabel('staging-01', 'agent'), 'staging-01-agent-nession');
  assert.equal(expectedHostLabel('preprod', 'ui'), 'preprod-ui-nession');
});

test('validator rejects duplicate, invalid, unknown and public non-MCP declarations', () => {
  const mutations = [
    ['duplicate-site-id', data => { data.sites.push(clone(data.sites[0])); }],
    ['duplicate-hostname', data => { data.sites[1].legacyFqdn = data.sites[0].legacyFqdn; }],
    ['site-fqdn-naming', data => {
      data.sites[0].fqdn = 'staging.nession.bestnathan.top';
      data.sites[0].legacyFqdn = null;
    }],
    ['unknown-environment', data => { data.sites[0].environment = 'qa'; }],
    ['unknown-service', data => { data.sites[0].service = 'gateway'; }],
    ['public-non-mcp', data => {
      data.sites[0].visibility = 'public';
      data.publicAllowlist.push('staging-server');
    }],
    ['public-not-allowlisted', data => { data.sites[3].visibility = 'public'; data.publicAllowlist.length = 0; }],
    ['allowlist-private-site', data => { data.publicAllowlist.push('staging-server'); }],
    ['backend-identity', data => { data.sites[0].backend.service = 'other-server'; }],
    ['backend-port', data => { data.sites[0].backend.port = 9999; }],
    ['route-policy', data => { data.sites[3].route = { path: '/', pathType: 'Prefix' }; }],
    ['lan-dns-ref', data => { data.sites[0].lanDns = '192.168.2.10'; }],
    ['private-public-fields', data => { data.sites[0].publicOrigin = 'CLOUDFLARE_ORIGIN_IPV4'; }],
    ['ownership-marker', data => { data.sites[3].ownershipMarker = 'managed-by:someone-else'; }],
    ['site-id-identity', data => { data.sites[0].id = 'staging-web'; }],
    ['site-fqdn-naming', data => { data.sites[0].fqdn = 'staging-web-nession.bestnathan.top'; }],
    ['legacy-fqdn', data => { data.sites[0].legacyFqdn = data.sites[0].fqdn; }],
    ['registry-zone', data => { data.zone = 'example.com'; }],
    ['enabled-flag', data => { data.sites[0].enabled = 'yes'; }],
    ['gitops-ref', data => { data.sites[0].gitops.path = '../escape.yaml'; }]
  ];
  for (const [invariant, mutate] of mutations) {
    const data = clone(registry);
    mutate(data);
    assert.throws(() => validateRegistry(data), new RegExp(invariant), invariant);
  }
  assert.throws(() => validateRegistry(null), /registry-object/);
  assert.throws(() => validateRegistry({ ...clone(registry), version: 2 }), /registry-version/);
});

test('LAN plan renders exactly one canonical host per enabled site with the fixed gateway', () => {
  const plan = renderLanPlan(registry, gateway);
  const enabled = registry.sites.filter(site => site.enabled);
  assert.equal(plan.length, enabled.length);
  assert.deepEqual(plan.map(entry => entry.domain),
    enabled.map(site => site.fqdn).sort());
  assert.ok(plan.every(entry => entry.answer === gateway && entry.answerRef === 'LAN_GATEWAY_IP'));
  assert.ok(!plan.some(entry => entry.domain === 'mcp-nession.bestnathan.top'));
  assert.ok(plan.some(entry => entry.domain === 'staging-mcp-nession.bestnathan.top'));
  assert.ok(!plan.some(entry => entry.domain.includes('.nession.bestnathan.top')));
  for (const invalid of ['', '8.8.4.4', '127.0.0.1', '169.254.1.1', '100.64.0.1', '2001:db8::1', '172.32.0.1']) {
    assert.throws(() => validateGatewayIpv4(invalid), /LAN_GATEWAY_IP/, invalid);
  }
  assert.equal(validateGatewayIpv4('10.1.2.3'), '10.1.2.3');
  assert.equal(validateGatewayIpv4('172.16.0.1'), '172.16.0.1');
  assert.throws(() => renderLanPlan(registry, '8.8.4.4'), /RFC1918/);
});

test('public plan maps only approved enabled MCP sites', () => {
  const plan = renderPublicPlan(registry);
  assert.deepEqual(plan.map(entry => entry.site), ['staging-mcp']);
  assert.equal(plan[0].hostname, 'staging-mcp-nession.bestnathan.top');
  assert.equal(plan[0].proxied, true);
  assert.equal(plan[0].comment, 'managed-by:nession:site=staging-mcp:issue=3963');
  const activated = clone(registry);
  activated.sites.find(site => site.id === 'production-mcp').enabled = true;
  assert.deepEqual(renderPublicPlan(activated).map(entry => entry.site),
    ['production-mcp', 'staging-mcp']);
});

test('render comparison accepts reviewed legacy hosts during migration and preserves nhome.local', () => {
  const report = compareGitops(registry, legacyGitopsFiles());
  assert.equal(report.ok, true);
  assert.deepEqual(report.unknownHosts, []);
  const byId = Object.fromEntries(report.sites.map(site => [site.id, site.status]));
  assert.equal(byId['production-server'], 'canonical');
  assert.equal(byId['staging-mcp'], 'canonical');
  assert.equal(byId['production-mcp'], 'canonical');
  assert.equal(byId['staging-server'], 'legacy');
  assert.equal(byId['production-agent'], 'legacy');
  assert.equal(byId['preprod-ui'], 'legacy');
  assert.ok(report.preservedLocalHosts.includes('nession.nhome.local'));
  assert.ok(report.preservedLocalHosts.includes('staging.agent.nession.nhome.local'));
  assert.equal(lanApplyReadiness(report, 'staging-server'), false);
  assert.equal(lanApplyReadiness(report, 'staging-mcp'), true);
  const migrated = compareGitops(registry, canonicalGitopsFiles());
  assert.equal(migrated.ok, true);
  assert.ok(migrated.sites.every(site => site.status === 'canonical'));
  assert.equal(lanApplyReadiness(migrated, 'staging-server'), true);
});

test('render comparison fails closed on unknown hosts, wrong identity and enrollment drift', () => {
  const files = legacyGitopsFiles();
  const extra = clone(files);
  extra['base/nession/ingress-ui.yaml'] += '---\n' + ingressDoc({
    name: 'rogue-ingress',
    rules: [rule('evil.bestnathan.top', 'nession-ui', 80)]
  });
  const unknown = compareGitops(registry, extra);
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.unknownHosts, ['evil.bestnathan.top']);

  const wrongBackend = legacyGitopsFiles();
  wrongBackend['environments/staging/nession/patch-ingress.yaml'] =
    wrongBackend['environments/staging/nession/patch-ingress.yaml']
      .replaceAll('name: nession-server\n                port:\n                  number: 10080',
        'name: other-server\n                port:\n                  number: 10080');
  const backendReport = compareGitops(registry, wrongBackend);
  assert.equal(backendReport.sites.find(site => site.id === 'staging-server').status, 'mismatch');

  const drift = legacyGitopsFiles();
  drift['environments/staging/mcp/kustomization.yaml'] = kustomization(['deployment.yaml', 'service.yaml']);
  const driftReport = compareGitops(registry, drift);
  assert.equal(driftReport.ok, false);
  assert.equal(driftReport.sites.find(site => site.id === 'staging-mcp').status, 'enrollment-drift');

  const missing = legacyGitopsFiles();
  delete missing['environments/preprod/nession/patch-ingress.yaml'];
  const missingReport = compareGitops(registry, missing);
  assert.equal(missingReport.sites.find(site => site.id === 'preprod-server').status, 'missing');

  const wildcard = legacyGitopsFiles();
  wildcard['base/nession/ingress-ui.yaml'] = ingressDoc({
    name: 'nession-ui',
    rules: [rule('*.bestnathan.top', 'nession-ui', 80)]
  });
  assert.equal(compareGitops(registry, wildcard).ok, false);

  const malformed = legacyGitopsFiles();
  malformed['base/nession/ingress-server.yaml'] =
    'kind: Ingress\nmetadata:\n  name: nession-server\nspec:\n  rules:\n    - host: nession.bestnathan.top\n';
  assert.throws(() => compareGitops(registry, malformed), /Unsupported ingress structure/);
});

test('strict ingress and kustomization readers reject incomplete structures', () => {
  assert.throws(() => parseIngressDocuments('kind: Ingress\nmetadata: {}\n'), /metadata.name/);
  assert.throws(() => parseIngressDocuments(
    'kind: Ingress\nmetadata:\n  name: x\nspec:\n  rules: []\n'), /no rules/);
  assert.deepEqual(parseKustomizationResources(kustomization(['a.yaml', 'b.yaml'])), ['a.yaml', 'b.yaml']);
  assert.deepEqual(parseKustomizationResources('kind: Kustomization\n'), []);
  assert.throws(() => parseKustomizationResources(null), /readback missing/);
});

test('approvals require reviewed identity, scope and registry binding', () => {
  const approvals = loaded.approvals;
  const lineage = findApproval(approvals, {
    site: 'staging-mcp', operation: 'public-activate', registryHash: loaded.registryHash,
    scope: { fqdn: 'staging-mcp-nession.bestnathan.top', visibility: 'public', originRef: 'CLOUDFLARE_ORIGIN_IPV4' }
  });
  assert.equal(lineage.id, 'lineage-staging-mcp-public-3963');
  assert.equal(findApproval(approvals, {
    site: 'production-mcp', operation: 'public-activate', registryHash: loaded.registryHash,
    scope: { fqdn: 'mcp-nession.bestnathan.top' }
  }), null);
  assert.equal(findApproval(approvals, {
    site: 'staging-mcp', operation: 'delete', registryHash: loaded.registryHash,
    scope: { fqdn: 'staging-mcp-nession.bestnathan.top' }
  }), null);
  assert.equal(findApproval(approvals, {
    site: 'staging-mcp', operation: 'public-activate', registryHash: loaded.registryHash,
    scope: { fqdn: 'other.bestnathan.top' }
  }), null);

  const fresh = {
    version: 1, issue: 4589,
    approvals: [{
      id: 'approve-production-mcp-public', site: 'production-mcp', operation: 'public-activate',
      scope: { fqdn: 'mcp-nession.bestnathan.top', visibility: 'public', originRef: 'CLOUDFLARE_ORIGIN_IPV4' },
      issue: 4589, approvedBy: 'operator', approvedAt: '2026-11-27',
      registryHash: loaded.registryHash
    }]
  };
  validateApprovals(fresh, registry);
  assert.equal(findApproval(fresh, {
    site: 'production-mcp', operation: 'public-activate', registryHash: loaded.registryHash,
    scope: { fqdn: 'mcp-nession.bestnathan.top', visibility: 'public', originRef: 'CLOUDFLARE_ORIGIN_IPV4' }
  }).id, 'approve-production-mcp-public');
  assert.equal(findApproval(fresh, {
    site: 'production-mcp', operation: 'public-activate', registryHash: 'f'.repeat(64),
    scope: { fqdn: 'mcp-nession.bestnathan.top' }
  }), null, 'registry change must invalidate a prior approval binding');

  const bad = [
    ['approval-unknown-site', entry => { entry.site = 'ghost'; }],
    ['approval-operation', entry => { entry.operation = 'force'; }],
    ['approval-scope-fqdn', entry => { entry.scope.fqdn = 'elsewhere.bestnathan.top'; }],
    ['approval-approver', entry => { delete entry.approvedBy; }],
    ['approval-date', entry => { entry.approvedAt = 'yesterday'; }],
    ['approval-registry-binding', entry => { entry.registryHash = 'short'; }]
  ];
  for (const [invariant, mutate] of bad) {
    const data = clone(fresh);
    mutate(data.approvals[0]);
    assert.throws(() => validateApprovals(data, registry), new RegExp(invariant), invariant);
  }
  assert.ok(SENSITIVE_OPERATIONS.includes('delete'));
  assert.ok(SENSITIVE_OPERATIONS.includes('origin-change'));
});

test('plan receipts bind exact revisions and never carry secret values', () => {
  const secretIp = '203.0.113.77';
  const token = 'super-secret-provider-token-value';
  const observedState = { records: [{ id: 'a', content: secretIp }], auth: token };
  const desiredState = { hostname: 'staging-mcp-nession.bestnathan.top', content: secretIp };
  const receipt = buildPlanReceipt({
    provider: 'cloudflare', mode: 'plan', environment: 'staging', site: 'staging-mcp',
    sourceSha, gitopsRevision, registryHash: loaded.registryHash,
    operations: [{ site: 'staging-mcp', kind: 'noop' }],
    observedState, desiredState, runId: '123', runAttempt: '1'
  });
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes(secretIp));
  assert.ok(!serialized.includes(token));
  assert.equal(receipt.receipt, 'NESSION_SITE_PLAN_V1');
  const context = {
    provider: 'cloudflare', environment: 'staging', site: 'staging-mcp',
    sourceSha, gitopsRevision, registryHash: loaded.registryHash,
    observedState, desiredState
  };
  assert.equal(verifyPlanReceipt(receipt, context), true);
  assert.throws(() => verifyPlanReceipt(receipt, {
    ...context, observedState: { records: [{ id: 'a', content: '198.51.100.9' }], auth: token }
  }), /provider state changed since plan/);
  assert.throws(() => verifyPlanReceipt(receipt, {
    ...context, desiredState: { hostname: 'staging-mcp-nession.bestnathan.top', content: '198.51.100.9' }
  }), /desired state changed since plan/);
  assert.throws(() => verifyPlanReceipt(receipt, { ...context, sourceSha: '3'.repeat(40) }), /source SHA changed/);
  assert.throws(() => verifyPlanReceipt(receipt, { ...context, gitopsRevision: '4'.repeat(40) }), /GitOps revision changed/);
  assert.throws(() => verifyPlanReceipt(receipt, { ...context, registryHash: '5'.repeat(64) }), /registry changed/);
  assert.throws(() => verifyPlanReceipt(receipt, { ...context, environment: 'production' }), /environment identity/);
  assert.throws(() => verifyPlanReceipt(receipt, { ...context, site: 'production-mcp' }), /site identity/);
  assert.throws(() => verifyPlanReceipt(receipt, { ...context, provider: 'adguard' }), /provider identity/);
  assert.throws(() => verifyPlanReceipt(null, context), /missing plan receipt/);
  assert.throws(() => buildPlanReceipt({
    provider: 'cloudflare', mode: 'plan', environment: 'staging', site: 'staging-mcp',
    sourceSha: 'short', gitopsRevision, registryHash: loaded.registryHash,
    operations: [], observedState: {}, desiredState: {}
  }), /exact 40-hex source SHA/);
  assert.equal(hashObservedState('x', { a: 1, b: 2 }), hashObservedState('x', { b: 2, a: 1 }));
});

test('canonical JSON hashing is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 4] } }),
    canonicalJson({ a: { c: [3, 4], d: 2 }, b: 1 }));
  assert.notEqual(sha256Hex(canonicalJson({ a: 1 })), sha256Hex(canonicalJson({ a: 2 })));
});

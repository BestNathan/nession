#!/usr/bin/env node
// Parallel gateway policy tests (#4719 SC-01). Positive assertions pin the
// three entrypoints, ownership and public allowlist; negative fixtures prove
// private/disabled exposure, wildcard authorization, HK->SLB chaining and
// Higress TLS dependency are rejected for migrated Nession route fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUSTER_HOP_IDS, ENTRYPOINT_IDS, OWNERSHIP, POLICY_ISSUE,
  PRIVATE_HOP_IDS, PROHIBITED, PUBLIC_HOP_IDS,
  evaluateRouteFixture, loadFixturePolicy, renderGatewayPolicy,
  validateGatewayPolicy, verifyGatewayPolicyRevision
} from './gateway-policy.mjs';
import { loadRegistry } from './site-registry.mjs';

const loaded = loadRegistry();
const registry = loaded.registry;
const sourceSha = 'a'.repeat(40);

function clone(value) {
  return structuredClone(value);
}

function route(overrides = {}) {
  return {
    site: 'staging-mcp',
    entrypoint: 'public',
    host: 'staging-mcp-nession.bestnathan.top',
    path: '/mcp',
    pathType: 'Exact',
    hops: ['cloudflare', 'hk', 'higress', 'service'],
    upstream: { protocol: 'http', tls: false, exposure: 'private-upstream' },
    ingressTls: false,
    publicNodePort: false,
    ...overrides
  };
}

test('rendered policy matches the checked-in fixture and declares parallel entrypoints', () => {
  const policy = renderGatewayPolicy(registry);
  assert.deepEqual(policy, loadFixturePolicy());
  assert.equal(policy.kind, 'nession-parallel-gateway-policy');
  assert.equal(policy.issue, POLICY_ISSUE);
  assert.deepEqual(Object.keys(policy.entrypoints).sort(), [...ENTRYPOINT_IDS].sort());
  assert.deepEqual(policy.entrypoints.public.hops.map(hop => hop.id), [...PUBLIC_HOP_IDS]);
  assert.deepEqual(policy.entrypoints.private.hops.map(hop => hop.id), [...PRIVATE_HOP_IDS]);
  assert.deepEqual(policy.entrypoints.cluster.hops.map(hop => hop.id), [...CLUSTER_HOP_IDS]);
  assert.equal(policy.entrypoints.public.gatewayOwner, 'nsible');
  assert.equal(policy.entrypoints.private.gatewayOwner, 'nitops');
  assert.equal(policy.ownership.certificateLifecycle, 'nitops');
  assert.equal(policy.tls.certificateOwner, 'nitops');
  assert.equal(policy.tls.nessionOwnsCertificate, false);
  assert.equal(policy.tls.higressBusinessTls, false);
  assert.deepEqual(policy.entrypoints.public.eligibleSites, ['production-mcp', 'staging-mcp']);
  assert.deepEqual(policy.entrypoints.public.activeSites, ['staging-mcp']);
  assert.deepEqual(policy.prohibited, [...PROHIBITED]);
  for (const prohibition of PROHIBITED) assert.ok(policy.prohibited.includes(prohibition));
  assert.ok(!JSON.stringify(policy).includes('192.168.'));
  assert.ok(!JSON.stringify(policy).includes('https://'));
  validateGatewayPolicy(policy, registry);
});

test('pinned policy requires and matches the exact reviewed SHA', () => {
  const pinned = renderGatewayPolicy(registry, { sourceRevision: sourceSha });
  assert.equal(pinned.source.revision, sourceSha);
  assert.equal(verifyGatewayPolicyRevision(pinned, sourceSha, registry), true);
  validateGatewayPolicy(pinned, registry, { requireRevision: true });
  const temporary = renderGatewayPolicy(registry);
  assert.throws(() => validateGatewayPolicy(temporary, registry, { requireRevision: true }),
    /source-revision/);
  assert.throws(() => verifyGatewayPolicyRevision(pinned, 'b'.repeat(40), registry),
    /source-revision-mismatch/);
  assert.throws(() => renderGatewayPolicy(registry, { sourceRevision: 'short' }),
    /source-revision/);
});

test('policy validator rejects topology, ownership and exposure mutations', () => {
  const mutations = [
    ['policy-kind', policy => { policy.kind = 'other'; }],
    ['policy-version', policy => { policy.version = 2; }],
    ['policy-issue', policy => { policy.issue = 4589; }],
    ['source-registry-hash', policy => { policy.source.registryHash = 'f'.repeat(64); }],
    ['source-revision-policy', policy => { policy.source.revisionRequirement = 'any'; }],
    ['ownership', policy => { policy.ownership.publicGateway = 'nession'; }],
    ['entrypoints', policy => { delete policy.entrypoints.cluster; }],
    ['entrypoint-hops', policy => { policy.entrypoints.public.hops.pop(); }],
    ['entrypoint-hops', policy => {
      policy.entrypoints.public.hops.splice(3, 0,
        { id: 'slb', owner: 'nitops', tls: 'wildcard-cert-manager' });
    }],
    ['higress-tls-dependency', policy => {
      policy.entrypoints.public.hops.find(hop => hop.id === 'higress').tls = true;
    }],
    ['higress-tls-dependency', policy => {
      policy.entrypoints.public.upstream.protocol = 'https';
    }],
    ['public-gateway-owner', policy => { policy.entrypoints.public.gatewayOwner = 'nitops'; }],
    ['private-gateway-owner', policy => { policy.entrypoints.private.gatewayOwner = 'nsible'; }],
    ['hop-owner', policy => {
      policy.entrypoints.public.hops.find(hop => hop.id === 'hk').owner = 'nitops';
    }],
    ['private-hosts-denied', policy => { policy.entrypoints.public.privateHostsDenied = []; }],
    ['entrypoint-hops', policy => {
      policy.entrypoints.private.hops.splice(2, 0, { id: 'cloudflare', owner: 'operator' });
    }],
    ['private-tls-owner', policy => {
      policy.entrypoints.private.hops.find(hop => hop.id === 'slb').tls = 'origin-ca';
    }],
    ['protected-origin-ref', policy => {
      policy.entrypoints.public.configRefs.origin = '198.51.100.7';
    }],
    ['protected-answer-ref', policy => {
      policy.entrypoints.private.configRefs.answer = '198.51.100.7';
    }],
    ['protected-config-ref', policy => {
      policy.entrypoints.private.configRefs.adguardUrl = 'http://192.168.2.10';
    }],
    ['literal-address', policy => { policy.note = '192.168.2.10'; }],
    ['public-eligibility', policy => { policy.entrypoints.public.eligibleSites = ['staging-mcp']; }],
    ['public-activation', policy => {
      policy.entrypoints.public.activeSites = ['production-mcp', 'staging-mcp'];
    }],
    ['public-activation', policy => {
      policy.entrypoints.public.activeSites = ['production-mcp', 'staging-mcp'];
      policy.entrypoints.public.routes.push({
        host: 'mcp-nession.bestnathan.top', path: '/mcp', pathType: 'Exact',
        backend: { service: 'nession-mcp-production', port: 9090 },
        originTls: 'full-strict', authentication: 'required'
      });
    }],
    ['wildcard-authorization', policy => {
      policy.entrypoints.public.routes[0].host = '*.bestnathan.top';
    }],
    ['competing-certificate-owner', policy => {
      policy.tls.certificateOwner = 'nession';
      policy.tls.nessionOwnsCertificate = true;
    }],
    ['tls-topology', policy => { policy.tls.clientFacingTerminators = ['hk']; }],
    ['prohibited-missing', policy => { policy.prohibited = []; }]
  ];
  for (const [invariant, mutate] of mutations) {
    const policy = clone(loadFixturePolicy());
    mutate(policy);
    assert.throws(() => validateGatewayPolicy(policy, registry), new RegExp(invariant), invariant);
  }
});

test('migrated public and private route fixtures are accepted at exact registry identity', () => {
  const publicRoute = evaluateRouteFixture(route(), { registry });
  assert.deepEqual(publicRoute, {
    decision: 'allow', site: 'staging-mcp', entrypoint: 'public',
    host: 'staging-mcp-nession.bestnathan.top', path: '/mcp',
    backend: { service: 'nession-mcp-staging', port: 9090 }
  });
  const privateRoute = evaluateRouteFixture({
    site: 'staging-server',
    entrypoint: 'private',
    host: 'staging-nession.bestnathan.top',
    path: '/',
    pathType: 'Prefix',
    hops: ['adguard', 'slb', 'higress', 'service'],
    upstream: { protocol: 'http', tls: false, exposure: 'private-upstream' }
  }, { registry });
  assert.equal(privateRoute.decision, 'allow');
  assert.equal(privateRoute.site, 'staging-server');
  const clusterRoute = evaluateRouteFixture({
    site: 'staging-server',
    entrypoint: 'cluster',
    host: 'staging-nession.bestnathan.top',
    path: '/',
    pathType: 'Prefix',
    hops: ['source-service', 'destination-service'],
    upstream: { protocol: 'http', tls: false, exposure: 'cluster' }
  }, { registry });
  assert.equal(clusterRoute.decision, 'allow');
});

test('route fixtures reject private, disabled and wildcard public exposure', () => {
  assert.throws(() => evaluateRouteFixture(route({
    site: 'staging-server', host: 'staging-nession.bestnathan.top',
    path: '/', pathType: 'Prefix'
  }), { registry }), /private-host-public-exposure/);
  assert.throws(() => evaluateRouteFixture(route({
    site: 'production-mcp', host: 'mcp-nession.bestnathan.top'
  }), { registry }), /disabled-host-public-exposure/);
  assert.throws(() => evaluateRouteFixture(route({ host: '*.bestnathan.top' }), { registry }),
    /wildcard-authorization/);
  assert.throws(() => evaluateRouteFixture(route({ wildcard: true }), { registry }),
    /wildcard-authorization/);
  assert.throws(() => evaluateRouteFixture(route({
    host: 'other-mcp-nession.bestnathan.top'
  }), { registry }), /route-host/);
  assert.throws(() => evaluateRouteFixture(route({ path: '/', pathType: 'Prefix' }), { registry }),
    /route-path/);
});

test('route fixtures reject HK->SLB chaining, Higress TLS and public NodePort exposure', () => {
  assert.throws(() => evaluateRouteFixture(route({
    hops: ['cloudflare', 'hk', 'slb', 'higress', 'service']
  }), { registry }), /hk-slb-chaining/);
  assert.throws(() => evaluateRouteFixture(route({ hkToSlb: true }), { registry }),
    /hk-slb-chaining/);
  assert.throws(() => evaluateRouteFixture(route({
    upstream: { protocol: 'https', tls: false, exposure: 'private-upstream' }
  }), { registry }), /higress-tls-dependency/);
  assert.throws(() => evaluateRouteFixture(route({
    upstream: { protocol: 'http', tls: false, exposure: 'private-upstream', port: 443 }
  }), { registry }), /higress-tls-dependency/);
  assert.throws(() => evaluateRouteFixture(route({ ingressTls: true }), { registry }),
    /higress-tls-dependency/);
  assert.throws(() => evaluateRouteFixture(route({ publicNodePort: true }), { registry }),
    /public-nodeport-exposure/);
  assert.throws(() => evaluateRouteFixture(route({
    upstream: { protocol: 'http', tls: false, exposure: 'public' }
  }), { registry }), /upstream-exposure/);
  assert.throws(() => evaluateRouteFixture(route({
    hops: ['cloudflare', 'hk', 'higress']
  }), { registry }), /public-route-chain/);
});

test('private route fixtures cannot depend on Cloudflare/HK or public hosts', () => {
  const base = {
    site: 'staging-server',
    entrypoint: 'private',
    host: 'staging-nession.bestnathan.top',
    path: '/',
    pathType: 'Prefix',
    hops: ['adguard', 'slb', 'higress', 'service'],
    upstream: { protocol: 'http', tls: false, exposure: 'private-upstream' }
  };
  assert.throws(() => evaluateRouteFixture({ ...base,
    hops: ['cloudflare', 'hk', 'adguard', 'slb', 'higress', 'service'] }, { registry }),
  /private-route-uses-public-provider/);
  assert.throws(() => evaluateRouteFixture({ ...base, site: 'staging-mcp',
    host: 'staging-mcp-nession.bestnathan.top', path: '/mcp', pathType: 'Exact' }, { registry }),
  /public-host-private-route/);
  assert.throws(() => evaluateRouteFixture({ ...base, hops: ['slb', 'higress', 'service'] },
    { registry }), /private-route-chain/);
  assert.throws(() => evaluateRouteFixture({ ...base, ingressTls: true }, { registry }),
    /higress-tls-dependency/);
});

test('cluster routes stay service-to-service without external gateways or TLS', () => {
  const base = {
    site: 'staging-server',
    entrypoint: 'cluster',
    host: 'staging-nession.bestnathan.top',
    path: '/',
    pathType: 'Prefix',
    hops: ['source-service', 'destination-service'],
    upstream: { protocol: 'http', tls: false, exposure: 'cluster' }
  };
  assert.throws(() => evaluateRouteFixture({ ...base,
    hops: ['source-service', 'hk', 'destination-service'] }, { registry }),
  /cluster-route-external-hop/);
  assert.throws(() => evaluateRouteFixture({ ...base, ingressTls: true }, { registry }),
    /higress-tls-dependency/);
});

test('public activation follows the registry enabled flag, not eligibility alone', () => {
  const activated = clone(registry);
  activated.sites.find(site => site.id === 'production-mcp').enabled = true;
  const policy = renderGatewayPolicy(activated);
  assert.deepEqual(policy.entrypoints.public.activeSites, ['production-mcp', 'staging-mcp']);
  assert.deepEqual(policy.entrypoints.public.routes.map(entry => entry.host),
    ['mcp-nession.bestnathan.top', 'staging-mcp-nession.bestnathan.top']);
  validateGatewayPolicy(policy, activated);
  const routeResult = evaluateRouteFixture(route({
    site: 'production-mcp', host: 'mcp-nession.bestnathan.top'
  }), { registry: activated });
  assert.equal(routeResult.decision, 'allow');
});

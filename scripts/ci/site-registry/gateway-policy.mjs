#!/usr/bin/env node
// Owner: #4719 SC-01 — versioned parallel public/private gateway policy.
//
// The reviewed site registry (registry.json, #4589) is the single authority for
// hostname, visibility, enabled state and path. This module adds the approved
// parallel-entrypoint contract around that authority:
//
//   Public:  Client -> Cloudflare -> HK (TLS + public ACL) -> WireGuard/gost
//            -> Higress HTTP -> Service
//   Private: LAN/VPN -> AdGuard DNS -> SLB (TLS) -> Higress HTTP -> Service
//   Cluster: Service -> Service
//
// Ownership is explicit: Nession owns site identity/visibility/enabled/path and
// the AdGuard record contract; nsible owns the HK public gateway; nitops owns
// the SLB private gateway and both certificate lifecycles. HK never chains to
// the SLB, migrated Higress routes carry no business TLS, wildcards authorize
// nothing, and disabled/private hosts never enter the public entrypoint.
//
// Rendered artifacts contain symbolic Environment/Variable/Secret references
// only (CLOUDFLARE_ORIGIN_IPV4, LAN_GATEWAY_IP, ADGUARD_*), never real
// addresses. Consumption pins the exact reviewed Nession revision; this module
// only renders and validates, it never configures a live provider.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LAN_ANSWER_REF, PUBLIC_ORIGIN_REF, ZONE, loadRegistry, registryHash,
  renderPublicPlan, validateRegistry
} from './site-registry.mjs';
import { renderEdgePolicy } from './edge-policy.mjs';

export const POLICY_KIND = 'nession-parallel-gateway-policy';
export const POLICY_VERSION = 1;
export const POLICY_ISSUE = 4719;
export const HEX40 = /^[0-9a-f]{40}$/;
export const ENTRYPOINT_IDS = Object.freeze(['public', 'private', 'cluster']);
export const PUBLIC_HOP_IDS = Object.freeze([
  'client', 'cloudflare', 'hk', 'wireguard-gost', 'higress', 'service'
]);
export const PRIVATE_HOP_IDS = Object.freeze([
  'client', 'adguard', 'slb', 'higress', 'service'
]);
export const CLUSTER_HOP_IDS = Object.freeze(['source-service', 'destination-service']);
export const OWNERSHIP = Object.freeze({
  siteIdentity: 'nession',
  publicGateway: 'nsible',
  privateGateway: 'nitops',
  certificateLifecycle: 'nitops',
  adguardRecords: 'nession',
  cloudflareRecords: 'operator-protected-config',
  gitopsRender: 'nession-gitops'
});
// Prohibitions the artifact declares and the validator enforces. They are the
// cross-repository review checklist for nsible/nitops consumers.
export const PROHIBITED = Object.freeze([
  'private-host-public-exposure',
  'disabled-host-public-exposure',
  'wildcard-authorization',
  'hk-slb-chaining',
  'higress-tls-dependency',
  'public-nodeport-exposure',
  'competing-certificate-owner'
]);

const PROTECTED_REF = /^(?:CLOUDFLARE_ORIGIN_IPV4|LAN_GATEWAY_IP|ADGUARD_API_URL|ADGUARD_USERNAME|ADGUARD_PASSWORD)$/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const URL_VALUE = /[a-z][a-z0-9+.-]*:\/\//i;

function fail(invariant, detail) {
  throw new Error('Parallel gateway policy invariant violated: ' + invariant +
    (detail ? ' (' + detail + ')' : ''));
}

function publicHops() {
  return [
    { id: 'client', owner: 'client', protocol: 'https' },
    { id: 'cloudflare', owner: 'operator-protected-config', tls: 'universal-ssl' },
    { id: 'hk', owner: 'nsible', tls: 'public-san', terminatesTls: true },
    { id: 'wireguard-gost', owner: 'nsible', transport: 'wireguard', protocol: 'http' },
    { id: 'higress', owner: 'nession-gitops', protocol: 'http', tls: false },
    { id: 'service', owner: 'nession-gitops', protocol: 'http' }
  ];
}

function privateHops() {
  return [
    { id: 'client', owner: 'client', network: 'lan-vpn' },
    { id: 'adguard', owner: 'nession', answerRef: LAN_ANSWER_REF },
    { id: 'slb', owner: 'nitops', tls: 'wildcard-cert-manager', terminatesTls: true },
    { id: 'higress', owner: 'nession-gitops', protocol: 'http', tls: false },
    { id: 'service', owner: 'nession-gitops', protocol: 'http' }
  ];
}

function clusterHops() {
  return [
    { id: 'source-service', owner: 'nession', protocol: 'http' },
    { id: 'destination-service', owner: 'nession', protocol: 'http' }
  ];
}

function privateHosts(registry) {
  return registry.sites
    .filter(site => site.visibility === 'private')
    .flatMap(site => [site.fqdn, site.legacyFqdn].filter(Boolean))
    .sort();
}

// Deterministic render. `sourceRevision` is the exact reviewed Nession commit
// the artifact is generated from; null only for the checked-in contract
// fixture, which must never be consumed as a pinned artifact.
export function renderGatewayPolicy(registry, { sourceRevision = null } = {}) {
  validateRegistry(registry);
  if (sourceRevision !== null && !HEX40.test(sourceRevision)) fail('source-revision');
  const edge = renderEdgePolicy(registry);
  return {
    kind: POLICY_KIND,
    version: POLICY_VERSION,
    issue: POLICY_ISSUE,
    zone: ZONE,
    source: {
      repository: 'BestNathan/nession',
      registryPath: 'scripts/ci/site-registry/registry.json',
      registryHash: registryHash(registry),
      revision: sourceRevision,
      revisionRequirement: 'exact-40-hex-at-consumption'
    },
    ownership: { ...OWNERSHIP },
    entrypoints: {
      public: {
        id: 'public-hk',
        trustBoundary: 'hk-public',
        gatewayOwner: OWNERSHIP.publicGateway,
        hops: publicHops(),
        eligibleSites: [...registry.publicAllowlist].sort(),
        activeSites: renderPublicPlan(registry).map(entry => entry.site).sort(),
        routes: edge.public,
        privateHostsDenied: privateHosts(registry),
        deny: edge.deny,
        upstream: { protocol: 'http', tls: false, exposure: 'private-upstream' },
        pathPolicy: 'exact-registry-route',
        configRefs: { origin: PUBLIC_ORIGIN_REF }
      },
      private: {
        id: 'private-slb',
        trustBoundary: 'lan-vpn',
        gatewayOwner: OWNERSHIP.privateGateway,
        hops: privateHops(),
        enabledHosts: privateHosts(registry),
        deny: {
          publicHost: 'reject', unknownHost: 'reject',
          nonLanSource: 'reject', wildcardFallback: 'reject'
        },
        upstream: { protocol: 'http', tls: false, exposure: 'private-upstream' },
        pathPolicy: 'registry-route',
        configRefs: {
          answer: LAN_ANSWER_REF,
          adguardUrl: 'ADGUARD_API_URL',
          adguardUsername: 'ADGUARD_USERNAME',
          adguardPassword: 'ADGUARD_PASSWORD'
        }
      },
      cluster: {
        id: 'cluster-service-to-service',
        trustBoundary: 'cluster',
        gatewayOwner: OWNERSHIP.siteIdentity,
        hops: clusterHops(),
        upstream: { protocol: 'http', tls: false, exposure: 'cluster' }
      }
    },
    tls: {
      clientFacingTerminators: ['hk', 'slb'],
      certificateOwner: OWNERSHIP.certificateLifecycle,
      nessionOwnsCertificate: false,
      higressBusinessTls: false,
      hkCertificate: 'public-san-distinct-key',
      slbCertificate: 'wildcard-cert-manager'
    },
    prohibited: [...PROHIBITED]
  };
}

function assertHopIds(hops, expected, entrypoint) {
  const ids = Array.isArray(hops) ? hops.map(hop => hop && hop.id) : [];
  if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
    fail('entrypoint-hops', entrypoint + ' must be exactly ' + expected.join('->'));
  }
}

function assertNoLiteralInfrastructure(policy) {
  const serialized = JSON.stringify(policy);
  if (IPV4.test(serialized)) fail('literal-address', 'policy must use protected references only');
  if (URL_VALUE.test(serialized)) fail('literal-url', 'policy must use protected references only');
}

export function validateGatewayPolicy(policy, registry, { requireRevision = false } = {}) {
  validateRegistry(registry);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('policy-object');
  if (policy.kind !== POLICY_KIND) fail('policy-kind');
  if (policy.version !== POLICY_VERSION) fail('policy-version');
  if (policy.issue !== POLICY_ISSUE) fail('policy-issue');
  if (policy.zone !== ZONE) fail('policy-zone');

  const source = policy.source ?? {};
  if (source.repository !== 'BestNathan/nession' ||
      source.registryPath !== 'scripts/ci/site-registry/registry.json') {
    fail('source-owner');
  }
  if (source.registryHash !== registryHash(registry)) fail('source-registry-hash');
  if (source.revisionRequirement !== 'exact-40-hex-at-consumption') fail('source-revision-policy');
  if (source.revision !== null && !HEX40.test(String(source.revision))) fail('source-revision');
  if (requireRevision && !HEX40.test(String(source.revision))) {
    fail('source-revision', 'a consumed artifact must pin the exact reviewed SHA');
  }

  if (JSON.stringify(policy.ownership) !== JSON.stringify(OWNERSHIP)) fail('ownership');

  const entrypoints = policy.entrypoints ?? {};
  const ids = Object.keys(entrypoints).sort();
  if (ids.length !== ENTRYPOINT_IDS.length ||
      ids.some((id, index) => id !== [...ENTRYPOINT_IDS].sort()[index])) {
    fail('entrypoints', 'exactly public, private and cluster are owned');
  }

  const publicEntry = entrypoints.public;
  assertHopIds(publicEntry.hops, PUBLIC_HOP_IDS, 'public');
  if (publicEntry.gatewayOwner !== OWNERSHIP.publicGateway) fail('public-gateway-owner');
  if (publicEntry.hops.some(hop => hop.id === 'slb')) fail('hk-slb-chaining');
  if (publicEntry.hops.some(hop => hop.id === 'higress' &&
      (hop.tls !== false || hop.protocol !== 'http'))) {
    fail('higress-tls-dependency');
  }
  if (publicEntry.upstream?.protocol !== 'http' || publicEntry.upstream?.tls !== false ||
      publicEntry.upstream?.exposure !== 'private-upstream') {
    fail('higress-tls-dependency');
  }
  if (publicEntry.configRefs?.origin !== PUBLIC_ORIGIN_REF) fail('protected-origin-ref');
  if (publicEntry.pathPolicy !== 'exact-registry-route') fail('public-path-policy');

  const privateEntry = entrypoints.private;
  assertHopIds(privateEntry.hops, PRIVATE_HOP_IDS, 'private');
  if (privateEntry.gatewayOwner !== OWNERSHIP.privateGateway) fail('private-gateway-owner');
  if (privateEntry.hops.some(hop => ['cloudflare', 'hk'].includes(hop.id))) {
    fail('private-route-uses-public-provider');
  }
  if (privateEntry.hops.some(hop => hop.id === 'slb' &&
      (hop.owner !== 'nitops' || hop.tls !== 'wildcard-cert-manager'))) {
    fail('private-tls-owner');
  }
  if (privateEntry.hops.some(hop => hop.id === 'higress' &&
      (hop.tls !== false || hop.protocol !== 'http'))) {
    fail('higress-tls-dependency');
  }
  if (privateEntry.upstream?.protocol !== 'http' || privateEntry.upstream?.tls !== false ||
      privateEntry.upstream?.exposure !== 'private-upstream') {
    fail('higress-tls-dependency');
  }
  if (privateEntry.configRefs?.answer !== LAN_ANSWER_REF) fail('protected-answer-ref');
  for (const key of ['adguardUrl', 'adguardUsername', 'adguardPassword']) {
    const value = privateEntry.configRefs?.[key];
    if (typeof value !== 'string' || !PROTECTED_REF.test(value)) {
      fail('protected-config-ref', 'private.' + key);
    }
  }
  const expectedPrivateHosts = privateHosts(registry);
  if (JSON.stringify(privateEntry.enabledHosts) !== JSON.stringify(expectedPrivateHosts)) {
    fail('private-hosts', 'enabled private hosts must match the registry');
  }

  const clusterEntry = entrypoints.cluster;
  assertHopIds(clusterEntry.hops, CLUSTER_HOP_IDS, 'cluster');
  if (clusterEntry.hops.some(hop => hop.tls === true || hop.tls === 'public-san')) {
    fail('cluster-external-tls');
  }
  if (clusterEntry.upstream?.protocol !== 'http' || clusterEntry.upstream?.tls !== false ||
      clusterEntry.upstream?.exposure !== 'cluster') {
    fail('cluster-transport');
  }

  // Public exposure is derived from the reviewed registry: eligibility is the
  // allowlist, activation additionally requires enabled=true.
  const expectedEligible = [...registry.publicAllowlist].sort();
  if (JSON.stringify(publicEntry.eligibleSites) !== JSON.stringify(expectedEligible)) {
    fail('public-eligibility');
  }
  const expectedActive = renderPublicPlan(registry).map(entry => entry.site).sort();
  if (JSON.stringify(publicEntry.activeSites) !== JSON.stringify(expectedActive)) {
    fail('public-activation');
  }
  for (const site of registry.sites) {
    if (site.visibility === 'public' && !site.enabled &&
        (publicEntry.activeSites.includes(site.id) ||
         publicEntry.routes.some(route => route.host === site.fqdn))) {
      fail('disabled-host-public-exposure', site.id);
    }
    if (site.visibility === 'private' &&
        publicEntry.routes.some(route => route.host === site.fqdn ||
          (site.legacyFqdn && route.host === site.legacyFqdn))) {
      fail('private-host-public-exposure', site.id);
    }
  }
  if (!Array.isArray(publicEntry.routes)) fail('public-routes');
  for (const route of publicEntry.routes) {
    if (typeof route.host !== 'string' || route.host.includes('*')) {
      fail('wildcard-authorization', String(route.host));
    }
    const site = registry.sites.find(candidate => candidate.fqdn === route.host);
    if (!site || site.visibility !== 'public' || !site.enabled) {
      fail('public-route', String(route.host));
    }
    if (route.path !== site.route.path || route.pathType !== site.route.pathType) {
      fail('public-route-path', site.id);
    }
    if (!publicEntry.activeSites.includes(site.id)) fail('public-activation', site.id);
  }
  if (publicEntry.routes.length !== publicEntry.activeSites.length) {
    fail('public-route-count');
  }

  const expectedEdge = renderEdgePolicy(registry);
  if (JSON.stringify(publicEntry.routes) !== JSON.stringify(expectedEdge.public) ||
      JSON.stringify(publicEntry.deny) !== JSON.stringify(expectedEdge.deny)) {
    fail('edge-policy', 'public routes/deny semantics must come from edge-policy.mjs');
  }

  if (policy.tls?.certificateOwner !== OWNERSHIP.certificateLifecycle ||
      policy.tls?.nessionOwnsCertificate !== false ||
      policy.tls?.higressBusinessTls !== false) {
    fail('competing-certificate-owner');
  }

  for (const prohibition of PROHIBITED) {
    if (!Array.isArray(policy.prohibited) || !policy.prohibited.includes(prohibition)) {
      fail('prohibited-missing', prohibition);
    }
  }
  assertNoLiteralInfrastructure(policy);
  return true;
}

// Route fixtures are the migrated Nession route declarations reviewed before
// nsible/nitops implement them. A fixture that would expose a private/disabled
// host, authorize a wildcard, chain HK to SLB, or depend on Higress TLS is
// rejected deterministically.
export function evaluateRouteFixture(fixture, { registry, policy = null } = {}) {
  if (!registry || typeof registry !== 'object') fail('route-registry');
  validateRegistry(registry);
  const rendered = policy ?? renderGatewayPolicy(registry);
  if (!fixture || typeof fixture !== 'object') fail('route-fixture');
  const site = registry.sites.find(candidate => candidate.id === fixture.site);
  if (!site) fail('route-site', String(fixture.site));

  if (fixture.entrypoint === 'public') {
    if (site.visibility !== 'public') fail('private-host-public-exposure', site.id);
    if (!site.enabled) fail('disabled-host-public-exposure', site.id);
  } else if (fixture.entrypoint === 'private') {
    if (site.visibility !== 'private') fail('public-host-private-route', site.id);
  } else if (fixture.entrypoint !== 'cluster') {
    fail('route-entrypoint', String(fixture.entrypoint));
  }

  if (typeof fixture.host !== 'string' || fixture.host.length === 0 ||
      fixture.host.includes('*') || fixture.wildcard === true) {
    fail('wildcard-authorization', String(fixture.host));
  }
  if (fixture.host !== site.fqdn) fail('route-host', site.id + ' must use ' + site.fqdn);
  if (fixture.path !== site.route.path || fixture.pathType !== site.route.pathType) {
    fail('route-path', site.id + ' must keep ' + site.route.path + '/' + site.route.pathType);
  }

  const hops = Array.isArray(fixture.hops) ? fixture.hops : [];
  if (fixture.entrypoint === 'public') {
    for (const required of ['cloudflare', 'hk', 'higress', 'service']) {
      if (!hops.includes(required)) fail('public-route-chain', 'missing ' + required);
    }
    if (hops.includes('slb') || fixture.hkToSlb === true) fail('hk-slb-chaining', site.id);
  }
  if (fixture.entrypoint === 'private') {
    for (const required of ['adguard', 'slb', 'higress', 'service']) {
      if (!hops.includes(required)) fail('private-route-chain', 'missing ' + required);
    }
    if (hops.includes('cloudflare') || hops.includes('hk')) {
      fail('private-route-uses-public-provider', site.id);
    }
  }
  if (fixture.entrypoint === 'cluster' &&
      hops.some(hop => ['cloudflare', 'hk', 'slb', 'adguard'].includes(hop))) {
    fail('cluster-route-external-hop', site.id);
  }
  if (fixture.publicNodePort === true || fixture.exposure === 'public-nodeport') {
    fail('public-nodeport-exposure', site.id);
  }

  const upstream = fixture.upstream ?? {};
  if (upstream.protocol !== 'http' || upstream.tls !== false ||
      fixture.ingressTls === true || upstream.port === 443) {
    fail('higress-tls-dependency', site.id);
  }
  if (fixture.entrypoint !== 'cluster' && upstream.exposure !== 'private-upstream') {
    fail('upstream-exposure', site.id);
  }

  // The rendered artifact must agree with the fixture's site/route identity.
  if (fixture.entrypoint === 'public' &&
      !rendered.entrypoints.public.activeSites.includes(site.id)) {
    fail('public-activation', site.id);
  }
  return {
    decision: 'allow',
    site: site.id,
    entrypoint: fixture.entrypoint,
    host: site.fqdn,
    path: site.route.path,
    backend: site.backend
  };
}

export function verifyGatewayPolicyRevision(policy, sourceRevision, registry) {
  validateGatewayPolicy(policy, registry, { requireRevision: true });
  if (!HEX40.test(String(sourceRevision ?? ''))) fail('source-revision');
  if (policy.source.revision !== sourceRevision) {
    fail('source-revision-mismatch', 'artifact was not generated from the reviewed SHA');
  }
  return true;
}

export function loadFixturePolicy(dir = path.dirname(fileURLToPath(import.meta.url))) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'gateway-policy.fixture.json'), 'utf8'));
}

function cli() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const sourceSha = process.env.SOURCE_SHA ?? null;
  const { registry } = loadRegistry();
  if (command === 'render') {
    const policy = renderGatewayPolicy(registry, { sourceRevision: sourceSha || null });
    validateGatewayPolicy(policy, registry, { requireRevision: Boolean(sourceSha) });
    console.log(JSON.stringify(policy, null, 2));
    return;
  }
  if (command === 'check-fixture') {
    const rendered = renderGatewayPolicy(registry);
    const fixture = loadFixturePolicy();
    validateGatewayPolicy(fixture, registry);
    if (JSON.stringify(rendered) !== JSON.stringify(fixture)) {
      console.error('Parallel gateway policy fixture drift: regenerate with `node ' +
        'scripts/ci/site-registry/gateway-policy.mjs render`');
      process.exitCode = 1;
      return;
    }
    console.log('PARALLEL_GATEWAY_POLICY_V1 public=' +
      rendered.entrypoints.public.activeSites.length + ' eligible=' +
      rendered.entrypoints.public.eligibleSites.length + ' private_hosts=' +
      rendered.entrypoints.private.enabledHosts.length);
    return;
  }
  if (command === 'validate') {
    const fixture = loadFixturePolicy();
    verifyGatewayPolicyRevision(fixture, sourceSha, registry);
    console.log('PARALLEL_GATEWAY_POLICY_PINNED_V1 revision=' + sourceSha);
    return;
  }
  throw new Error('usage: gateway-policy.mjs <render|check-fixture|validate>');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    cli();
  } catch (error) {
    console.error('Parallel gateway policy operation failed: ' + error.message);
    process.exitCode = 1;
  }
}

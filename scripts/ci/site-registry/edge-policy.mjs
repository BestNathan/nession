#!/usr/bin/env node
// Deterministic public-edge policy contract (#4589 SC-03). This module owns
// the reviewed allow/deny semantics shared with nitops#2 (the actual edge
// enforcement owner); it never configures a live router. Only approved,
// enabled Nession MCP hosts with the exact /mcp path may pass the public
// edge. Private/unknown Host/SNI, spoofed forwarding identity and non-
// Cloudflare direct-origin sources are denied with no fallback to private
// routes. DNS absence, CF WAF alone and client headers are never the boundary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRegistry, renderPublicPlan, ZONE } from './site-registry.mjs';
import { cidrContainsIpv4 } from '../configure-cloudflare-site.mjs';

const loaded = loadRegistry();

export function renderEdgePolicy(registry = loaded.registry) {
  const publicSites = renderPublicPlan(registry).map(entry => {
    const site = registry.sites.find(candidate => candidate.id === entry.site);
    return {
      host: entry.hostname,
      path: site.route.path,
      pathType: site.route.pathType,
      backend: { service: site.backend.service, port: site.backend.port },
      originTls: 'full-strict',
      authentication: 'required'
    };
  });
  const privateHosts = registry.sites
    .filter(site => site.visibility === 'private')
    .flatMap(site => [site.fqdn, site.legacyFqdn].filter(Boolean))
    .sort();
  return {
    version: 1,
    issue: 4589,
    zone: ZONE,
    public: publicSites,
    privateHosts,
    deny: {
      unknownHost: 'reject',
      privateHost: 'reject',
      sniMismatch: 'reject',
      nonExactPath: 'reject',
      spoofedForwarding: 'reject',
      untrustedForwardingSource: 'reject',
      nonCloudflareOriginSource: 'reject',
      wildcardFallback: 'reject'
    },
    trustedForwardingSources: 'cloudflare-ipv4-cidrs',
    lanRoute: 'separate-private-authority'
  };
}

function isNessionHost(host) {
  return host === 'nession.' + ZONE || host.endsWith('-nession.' + ZONE);
}

// Pure allow/deny evaluation against the rendered policy. `cloudflareCidrs`
// must come from the authoritative provider /ips readback at the enforcing
// edge, never a stale hardcoded list.
export function evaluateEdgeRequest(policy, request, { cloudflareCidrs = [] } = {}) {
  const deny = reason => ({ decision: 'deny', reason });
  if (!request || typeof request.host !== 'string' || request.host.length === 0) {
    return deny('unknown-host');
  }
  const host = request.host.toLowerCase();
  if (host.includes('*')) return deny('wildcard-host');
  const entry = policy.public.find(candidate => candidate.host === host);
  if (!entry) {
    if (policy.privateHosts.includes(host) || isNessionHost(host)) {
      return deny('private-host');
    }
    return deny('unknown-host');
  }
  // Direct-IP forced Host and SNI mismatch never reach a backend.
  if (typeof request.sni !== 'string' || request.sni.toLowerCase() !== host) {
    return deny('sni-mismatch');
  }
  const pathname = String(request.path ?? '').split('?')[0];
  if (entry.pathType !== 'Exact' || pathname !== entry.path) {
    return deny('non-exact-path');
  }
  if (!Array.isArray(cloudflareCidrs) || cloudflareCidrs.length === 0 ||
      typeof request.sourceIp !== 'string' ||
      !cloudflareCidrs.some(cidr => {
        try {
          return cidrContainsIpv4(cidr, request.sourceIp);
        } catch {
          return false;
        }
      })) {
    return deny('non-cloudflare-source');
  }
  // Forwarded identity is only trusted from the verified Cloudflare source
  // boundary above; client-supplied forwarding headers never widen trust.
  if ('forwardedHost' in request && request.forwardedHost !== host) {
    return deny('spoofed-forwarding');
  }
  if ('forwardedProto' in request && request.forwardedProto !== 'https') {
    return deny('spoofed-forwarding');
  }
  if ('forwardedFor' in request &&
      (typeof request.forwardedFor !== 'string' || request.forwardedFor.length === 0)) {
    return deny('spoofed-forwarding');
  }
  return { decision: 'allow', host, backend: entry.backend, path: entry.path };
}

export function loadFixturePolicy(dir = path.dirname(fileURLToPath(import.meta.url))) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'edge-policy.fixture.json'), 'utf8'));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const command = process.argv[2];
  if (command === 'render') {
    console.log(JSON.stringify(renderEdgePolicy(), null, 2));
  } else if (command === 'check-fixture') {
    const rendered = renderEdgePolicy();
    const fixture = loadFixturePolicy();
    if (JSON.stringify(rendered) !== JSON.stringify(fixture)) {
      console.error('Edge policy fixture drift: regenerate with `node scripts/ci/site-registry/edge-policy.mjs render`');
      process.exitCode = 1;
    } else {
      console.log('EDGE_POLICY_FIXTURE_V1 public=' + rendered.public.length +
        ' private_hosts=' + rendered.privateHosts.length);
    }
  } else {
    console.error('usage: edge-policy.mjs <render|check-fixture>');
    process.exitCode = 1;
  }
}

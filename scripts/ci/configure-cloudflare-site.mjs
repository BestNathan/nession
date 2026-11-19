#!/usr/bin/env node
// Review-owned DNS only. Cloudflare credentials and origin IP are protected
// GitHub Environment inputs, never workflow_dispatch parameters (#3963).
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const MARKER = 'managed-by:nession:site=staging-mcp:issue=3963';

export const SITES = Object.freeze({
  'staging-mcp': Object.freeze({
    environment: 'staging',
    zone: 'bestnathan.top',
    hostname: 'staging-mcp-nession.bestnathan.top',
    recordType: 'A',
    proxied: true,
    ttl: 1,
    comment: MARKER
  })
});

export function getSite(siteId) {
  const site = Object.hasOwn(SITES, siteId) ? SITES[siteId] : null;
  if (!site) throw new Error('Unregistered site; only reviewed site names are allowed');
  return site;
}

export function validateOriginIpv4(ip) {
  if (typeof ip !== 'string' || net.isIP(ip) !== 4) {
    throw new Error('CLOUDFLARE_ORIGIN_IPV4 must be one public IPv4 address');
  }
  const [a, b, c] = ip.split('.').map(Number);
  // Block private, loopback, CGNAT, link-local, documentation, multicast,
  // reserved and benchmarking ranges. Cloudflare edge IPs are blocked later
  // using the authoritative /ips endpoint, not a stale hardcoded allowlist.
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || (b === 168) || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 192 && b === 0 && c === 2)) {
    throw new Error('CLOUDFLARE_ORIGIN_IPV4 must not be private, reserved or documentation IP');
  }
  return ip;
}

function ipv4Value(ip) {
  if (net.isIP(ip) !== 4) throw new Error('Invalid Cloudflare IPv4 CIDR');
  return ip.split('.').reduce((n, byte) => ((n << 8) | Number(byte)) >>> 0, 0);
}

export function cidrContainsIpv4(cidr, ipv4) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr);
  if (!match || net.isIP(match[1]) !== 4) throw new Error('Invalid Cloudflare IPv4 CIDR');
  const bits = Number(match[2]);
  if (bits < 0 || bits > 32) throw new Error('Invalid Cloudflare IPv4 CIDR mask');
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Value(match[1]) & mask) === (ipv4Value(ipv4) & mask);
}

export function validateInputs({ apiToken, zoneId, originIpv4 }) {
  if (typeof apiToken !== 'string' || apiToken.length < 20 ||
      !/^[\x21-\x7e]+$/.test(apiToken)) {
    throw new Error('Missing or invalid CLOUDFLARE_API_TOKEN');
  }
  if (typeof zoneId !== 'string' || !/^[0-9a-f]{32}$/i.test(zoneId)) {
    throw new Error('CLOUDFLARE_ZONE_ID must be an exact Cloudflare zone identifier');
  }
  return { token: apiToken, zoneId, originIpv4: validateOriginIpv4(originIpv4) };
}

export function planRecord(site, records, origin) {
  if (!Array.isArray(records)) throw new Error('Cloudflare DNS readback missing');
  if (records.some(record => record?.name !== site.hostname)) {
    throw new Error('Provider DNS readback escaped the registered hostname');
  }
  const addressRecords = records.filter(record =>
    ['A', 'AAAA', 'CNAME'].includes(record.type));
  if (addressRecords.length > 1 ||
      addressRecords.some(record => record.type !== site.recordType)) {
    return { kind: 'blocked', reason: 'DNS address record collision' };
  }
  const existing = addressRecords[0];
  if (!existing) return { kind: 'create', recordId: null };
  if (existing.content === origin && existing.proxied === site.proxied &&
      existing.ttl === site.ttl) {
    return { kind: 'noop', recordId: existing.id, owned: existing.comment === site.comment };
  }
  if (existing.comment !== site.comment) {
    return { kind: 'blocked', reason: 'Existing DNS record has another owner' };
  }
  if (!/^[0-9a-f]{32}$/i.test(existing.id ?? '')) {
    throw new Error('Cloudflare DNS record ID is invalid');
  }
  return { kind: 'update', recordId: existing.id };
}

function recordBody(site, origin) {
  return {
    type: site.recordType,
    name: site.hostname,
    content: origin,
    ttl: site.ttl,
    proxied: site.proxied,
    comment: site.comment
  };
}

function createClient(credentials, fetchImpl) {
  return async (method, relativeUrl, payload) => {
    const response = await fetchImpl(API + relativeUrl, {
      method,
      headers: {
        Authorization: 'Bearer ' + credentials.token,
        'Content-Type': 'application/json'
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15000)
    });
    // Never echo the provider's free-text error body, headers or request:
    // these can disclose user-controlled values or credentials.
    if (!response || !Number.isInteger(response.status)) {
      throw new Error('Cloudflare returned an invalid HTTP response');
    }
    if (!response.ok) throw new Error('Cloudflare API rejected request (HTTP ' + response.status + ')');
    const doc = await response.json().catch(() => null);
    if (!doc || doc.success !== true || !Object.hasOwn(doc, 'result')) {
      throw new Error('Cloudflare API response failed validation');
    }
    return doc;
  };
}

async function listExactRecords(call, site, zoneId) {
  const relativeUrl = '/zones/' + zoneId + '/dns_records?name=' +
    encodeURIComponent(site.hostname) + '&per_page=100';
  const doc = await call('GET', relativeUrl);
  if (!Array.isArray(doc.result) ||
      (doc.result_info && (doc.result_info.total_pages > 1 ||
        doc.result_info.total_count > doc.result.length))) {
    throw new Error('Cloudflare DNS readback is incomplete');
  }
  return doc.result;
}

export async function configureSite({
  mode, siteId, environment, apiToken, zoneId, originIpv4,
  fetchImpl = globalThis.fetch, logger = () => {}
}) {
  if (mode !== 'plan' && mode !== 'apply') {
    throw new Error('Unsupported site operation: expected plan or apply');
  }
  const site = getSite(siteId);
  if (environment !== site.environment) {
    throw new Error('Site and GitHub Environment identity mismatch');
  }
  const credentials = validateInputs({ apiToken, zoneId, originIpv4 });
  const call = createClient(credentials, fetchImpl);

  const zone = (await call('GET', '/zones/' + credentials.zoneId)).result;
  if (zone?.name !== site.zone || zone?.id !== credentials.zoneId ||
      zone?.status !== 'active') {
    throw new Error('Cloudflare Zone identity or active status mismatch');
  }

  const ips = (await call('GET', '/ips')).result?.ipv4_cidrs;
  if (!Array.isArray(ips) || ips.length === 0 ||
      ips.some(cidr => typeof cidr !== 'string')) {
    throw new Error('Cloudflare edge IP range validation unavailable');
  }
  if (ips.some(cidr => cidrContainsIpv4(cidr, credentials.originIpv4))) {
    throw new Error('CLOUDFLARE_ORIGIN_IPV4 points to Cloudflare edge, not Higress origin');
  }

  const existing = await listExactRecords(call, site, credentials.zoneId);
  const plan = planRecord(site, existing, credentials.originIpv4);
  logger('site=' + siteId + ' mode=' + mode + ' dns=' + plan.kind +
    ' (origin IP hidden)');
  if (plan.kind === 'blocked') {
    throw new Error('Cloudflare DNS operation blocked: ' + plan.reason);
  }
  if (mode === 'plan' || plan.kind === 'noop') return plan;

  const body = recordBody(site, credentials.originIpv4);
  const prefix = '/zones/' + credentials.zoneId + '/dns_records';
  const method = plan.kind === 'create' ? 'POST' : 'PATCH';
  const path = plan.kind === 'create' ? prefix : prefix + '/' + plan.recordId;
  const written = (await call(method, path, body)).result;
  if (written?.name !== site.hostname || written?.type !== site.recordType ||
      written?.content !== credentials.originIpv4 || written?.proxied !== true ||
      written?.comment !== site.comment) {
    throw new Error('Cloudflare DNS write acknowledgment mismatch');
  }

  // Independent provider readback prevents reporting success from a lone 2xx.
  const verified = planRecord(
    site, await listExactRecords(call, site, credentials.zoneId),
    credentials.originIpv4
  );
  if (verified.kind !== 'noop' || verified.recordId !== written.id ||
      verified.owned !== true) {
    throw new Error('Cloudflare DNS post-write readback mismatch');
  }
  logger('site=' + siteId + ' provider DNS readback verified (origin IP hidden)');
  return { kind: plan.kind, verified: true };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , mode, siteId] = process.argv;
  const environment = process.env.TARGET_ENVIRONMENT;
  configureSite({
    mode,
    siteId,
    environment,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    originIpv4: process.env.CLOUDFLARE_ORIGIN_IPV4,
    logger: line => console.log(line)
  }).catch(error => {
    console.error('Cloudflare site configuration failed: ' + error.message);
    process.exitCode = 1;
  });
}

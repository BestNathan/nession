#!/usr/bin/env node
// Review-owned public DNS only (#3963, extended by #4589). Cloudflare
// credentials and origin IP are protected GitHub Environment inputs, never
// workflow_dispatch parameters. The canonical site registry owns identity
// and the MCP-only public allowlist: private or unknown sites fail before
// any Cloudflare request, and sensitive operations require a reviewed
// explicit approval bound to the exact desired state.
import fs from 'node:fs';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  loadRegistry, findApproval, buildPlanReceipt, verifyPlanReceipt,
  PUBLIC_ORIGIN_REF, ZONE
} from './site-registry/site-registry.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const loaded = loadRegistry();

export const SITES = Object.freeze(Object.fromEntries(
  loaded.registry.sites
    .filter(site => site.visibility === 'public')
    .map(site => [site.id, Object.freeze({
      environment: site.environment,
      zone: ZONE,
      hostname: site.fqdn,
      recordType: 'A',
      proxied: true,
      ttl: 1,
      comment: site.ownershipMarker
    })])
));

export function getSite(siteId) {
  const site = typeof siteId === 'string'
    ? loaded.registry.sites.find(entry => entry.id === siteId)
    : null;
  if (!site) throw new Error('Unregistered site; only reviewed site names are allowed');
  if (site.visibility !== 'public') {
    throw new Error('Private site; Cloudflare is not a DNS provider for private Nession sites');
  }
  return {
    id: site.id,
    environment: site.environment,
    zone: ZONE,
    hostname: site.fqdn,
    recordType: 'A',
    proxied: true,
    ttl: 1,
    comment: site.ownershipMarker,
    enabled: site.enabled
  };
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

async function readProviderState(call, site, credentials) {
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
  return listExactRecords(call, site, credentials.zoneId);
}

// Sensitive operations need a reviewed explicit approval matching the exact
// desired state; maintenance of an already-approved owned record does not.
function sensitiveOperation(site, plan, records, origin) {
  if (plan.kind === 'create') {
    return {
      operation: 'public-activate',
      scope: { fqdn: site.hostname, visibility: 'public', originRef: PUBLIC_ORIGIN_REF }
    };
  }
  if (plan.kind === 'update') {
    const existing = records.find(record => record.id === plan.recordId);
    if (existing && existing.content !== origin) {
      return {
        operation: 'origin-change',
        scope: { fqdn: site.hostname, originRef: PUBLIC_ORIGIN_REF }
      };
    }
  }
  return null;
}

export async function configureSite({
  mode, siteId, environment, apiToken, zoneId, originIpv4,
  fetchImpl = globalThis.fetch, logger = () => {},
  planReceipt = null, sourceSha = null, gitopsRevision = null,
  approvals = loaded.approvals, registryHash = loaded.registryHash
}) {
  if (!['plan', 'plan-delete', 'apply', 'reconcile', 'delete'].includes(mode)) {
    throw new Error('Unsupported site operation: expected plan, plan-delete, apply, reconcile or delete');
  }
  const site = getSite(siteId);
  if (environment !== site.environment) {
    throw new Error('Site and GitHub Environment identity mismatch');
  }
  if (!site.enabled && mode !== 'plan' && mode !== 'plan-delete') {
    throw new Error('Site is not activated; public activation requires a reviewed registry change and explicit approval');
  }
  const credentials = validateInputs({ apiToken, zoneId, originIpv4 });
  const call = createClient(credentials, fetchImpl);
  const existing = await readProviderState(call, site, credentials);

  if (mode === 'plan-delete' || mode === 'delete') {
    return deleteFlow({
      mode, site, credentials, call, existing, approvals, registryHash,
      planReceipt, sourceSha, gitopsRevision, logger
    });
  }

  const plan = planRecord(site, existing, credentials.originIpv4);
  const desiredState = recordBody(site, credentials.originIpv4);
  logger('site=' + siteId + ' mode=' + mode + ' dns=' + plan.kind +
    ' (origin IP hidden)');
  if (plan.kind === 'blocked') {
    throw new Error('Cloudflare DNS operation blocked: ' + plan.reason);
  }
  const sensitive = sensitiveOperation(site, plan, existing, credentials.originIpv4);
  const approval = sensitive
    ? findApproval(approvals, {
      site: siteId, operation: sensitive.operation, registryHash, scope: sensitive.scope
    })
    : null;
  if (mode === 'plan') {
    const result = { ...plan, approvalRequired: sensitive ? sensitive.operation : null,
      approved: Boolean(approval) };
    if (sourceSha && gitopsRevision) {
      result.receipt = buildPlanReceipt({
        provider: 'cloudflare', mode: 'plan', environment, site: siteId,
        sourceSha, gitopsRevision, registryHash,
        operations: [{ site: siteId, kind: plan.kind,
          approvalRequired: sensitive ? sensitive.operation : null }],
        observedState: existing, desiredState,
        runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT
      });
    }
    return result;
  }
  if (plan.kind === 'noop') return plan;

  // apply/reconcile must present the reviewed plan receipt and match fresh
  // provider state; a stale plan fails closed before any mutation.
  verifyPlanReceipt(planReceipt, {
    provider: 'cloudflare', environment, site: siteId, sourceSha, gitopsRevision,
    registryHash, observedState: existing, desiredState
  });
  if (sensitive && !approval) {
    if (mode === 'reconcile') {
      logger('site=' + siteId + ' reconcile skipped: ' + sensitive.operation + ' requires reviewed approval');
      return { kind: 'skipped', reason: 'approval-required', operation: sensitive.operation };
    }
    throw new Error('Cloudflare DNS operation blocked: ' + sensitive.operation +
      ' requires a reviewed explicit approval');
  }

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

// Exact owned-record removal only: reviewed approval bound to the record ID,
// fresh state verification immediately before deletion, independent readback
// afterwards. Wildcard, shared, unowned or colliding records are never deleted.
async function deleteFlow({
  mode, site, credentials, call, existing, approvals, registryHash,
  planReceipt, sourceSha, gitopsRevision, logger
}) {
  if (site.hostname.startsWith('*.')) {
    throw new Error('Cloudflare DNS operation blocked: wildcard records are never deleted');
  }
  const addressRecords = existing.filter(record => ['A', 'AAAA', 'CNAME'].includes(record.type));
  const desiredState = { removal: { name: site.hostname, type: site.recordType } };
  if (mode === 'plan-delete') {
    const candidate = addressRecords.length === 1 ? addressRecords[0] : null;
    const approval = candidate
      ? findApproval(approvals, {
        site: site.id, operation: 'delete', registryHash,
        scope: { fqdn: site.hostname, recordId: candidate.id, recordType: candidate.type }
      })
      : null;
    const kind = addressRecords.length !== 1 ? 'blocked'
      : candidate.comment !== site.comment ? 'blocked'
        : approval ? 'delete' : 'blocked';
    const reason = addressRecords.length !== 1 ? 'DNS address record collision'
      : candidate.comment !== site.comment ? 'Existing DNS record has another owner'
        : approval ? null : 'deletion requires a reviewed explicit approval bound to the exact record';
    logger('site=' + site.id + ' mode=plan-delete dns=' + kind + ' (origin IP hidden)');
    const result = { kind, recordId: candidate?.id ?? null, reason, approved: Boolean(approval) };
    if (sourceSha && gitopsRevision) {
      result.receipt = buildPlanReceipt({
        provider: 'cloudflare', mode: 'plan-delete', environment: site.environment, site: site.id,
        sourceSha, gitopsRevision, registryHash,
        operations: [{ site: site.id, kind, recordId: candidate?.id ?? null }],
        observedState: existing, desiredState,
        runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT
      });
    }
    return result;
  }
  if (addressRecords.length !== 1) {
    throw new Error('Cloudflare DNS operation blocked: DNS address record collision');
  }
  const record = addressRecords[0];
  if (record.name !== site.hostname || record.type !== site.recordType) {
    throw new Error('Cloudflare DNS operation blocked: record identity escaped the registered site');
  }
  if (record.comment !== site.comment) {
    throw new Error('Cloudflare DNS operation blocked: Existing DNS record has another owner');
  }
  const approval = findApproval(approvals, {
    site: site.id, operation: 'delete', registryHash,
    scope: { fqdn: site.hostname, recordId: record.id, recordType: record.type }
  });
  if (!approval) {
    throw new Error('Cloudflare DNS operation blocked: deletion requires a reviewed explicit approval bound to the exact record');
  }
  verifyPlanReceipt(planReceipt, {
    provider: 'cloudflare', environment: site.environment, site: site.id,
    sourceSha, gitopsRevision, registryHash, observedState: existing, desiredState
  });
  if (!/^[0-9a-f]{32}$/i.test(record.id ?? '')) {
    throw new Error('Cloudflare DNS record ID is invalid');
  }
  await call('DELETE', '/zones/' + credentials.zoneId + '/dns_records/' + record.id);
  const after = await listExactRecords(call, site, credentials.zoneId);
  if (after.some(entry => entry.id === record.id)) {
    throw new Error('Cloudflare DNS post-delete readback mismatch');
  }
  logger('site=' + site.id + ' owned record deletion verified by provider readback');
  return { kind: 'delete', verified: true };
}

// Sanitized mutation result receipt: binds the reviewed plan identity and
// the observed operation outcome without any provider secret values.
export function buildResultReceipt({
  mode, environment, site, sourceSha, gitopsRevision, registryHash,
  planReceipt, result
}) {
  if (!planReceipt || planReceipt.receipt !== 'NESSION_SITE_PLAN_V1') {
    throw new Error('Result receipt requires the reviewed plan receipt');
  }
  return {
    receipt: 'NESSION_SITE_RESULT_V1',
    provider: 'cloudflare', mode, environment, site,
    sourceSha, gitopsRevision, registryHash,
    planHash: planReceipt.planHash,
    operation: result.kind,
    verified: result.verified === true,
    runId: String(process.env.GITHUB_RUN_ID ?? ''),
    runAttempt: String(process.env.GITHUB_RUN_ATTEMPT ?? ''),
    createdAt: new Date().toISOString()
  };
}

function readReceiptFile() {
  const file = process.env.SITE_PLAN_RECEIPT;
  if (!file) throw new Error('SITE_PLAN_RECEIPT must reference the reviewed plan receipt artifact');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cliContext() {
  const sourceSha = process.env.SOURCE_SHA;
  const gitopsRevision = process.env.GITOPS_REVISION;
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '') || !/^[0-9a-f]{40}$/.test(gitopsRevision ?? '')) {
    throw new Error('SOURCE_SHA and GITOPS_REVISION must be exact 40-hex revisions');
  }
  return { sourceSha, gitopsRevision };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , mode, siteId] = process.argv;
  const environment = process.env.TARGET_ENVIRONMENT;
  const needsReceipt = mode === 'apply' || mode === 'reconcile' || mode === 'delete';
  const context = mode === 'plan' || mode === 'plan-delete' || needsReceipt ? cliContext() : {};
  configureSite({
    mode,
    siteId,
    environment,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    originIpv4: process.env.CLOUDFLARE_ORIGIN_IPV4,
    planReceipt: needsReceipt ? readReceiptFile() : null,
    ...context,
    logger: line => console.log(line)
  }).then(result => {
    if (result?.receipt && process.env.SITE_PLAN_OUT) {
      fs.writeFileSync(process.env.SITE_PLAN_OUT, JSON.stringify(result.receipt, null, 2) + '\n', { mode: 0o600 });
      console.log('site=' + siteId + ' sanitized plan receipt written (no provider values)');
    } else if (needsReceipt && process.env.SITE_PLAN_OUT) {
      const receipt = buildResultReceipt({
        mode, environment, site: siteId,
        sourceSha: context.sourceSha, gitopsRevision: context.gitopsRevision,
        registryHash: loaded.registryHash,
        planReceipt: readReceiptFile(), result
      });
      fs.writeFileSync(process.env.SITE_PLAN_OUT, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
      console.log('site=' + siteId + ' sanitized result receipt written (no provider values)');
    }
  }).catch(error => {
    console.error('Cloudflare site configuration failed: ' + error.message);
    process.exitCode = 1;
  });
}

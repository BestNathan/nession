#!/usr/bin/env node
// LAN split-horizon DNS owner (#4589). Exact AdGuard Home rewrites for the
// reviewed enabled site set, executed only from the protected main-owned
// workflow through a job-scoped VPN. The registry is the durable reviewed
// managed-record inventory (expected domain + LAN_GATEWAY_IP answer);
// ownership is never inferred from suffixes, caches or artifacts. Matching
// unmanaged records stay untouched, conflicts fail closed, and deletion
// requires an explicit reviewed approval plus fresh exact-state verification.
import fs from 'node:fs';
import dns from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import {
  loadRegistry, renderLanPlan, findApproval, buildPlanReceipt,
  verifyPlanReceipt, validateGatewayIpv4, LAN_ANSWER_REF
} from './site-registry/site-registry.mjs';

const loaded = loadRegistry();

export function validateAdguardInputs({ apiUrl, username, password, gatewayIp }) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error('ADGUARD_API_URL must be a valid HTTPS management endpoint');
  }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('ADGUARD_API_URL must be a bare HTTPS origin without credentials, query or path');
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) {
    // An IP-literal management endpoint must be internal address space.
    validateGatewayIpv4(url.hostname);
  }
  if (typeof username !== 'string' || username.length === 0 ||
      typeof password !== 'string' || password.length === 0) {
    throw new Error('Missing or invalid ADGUARD_USERNAME/ADGUARD_PASSWORD');
  }
  validateGatewayIpv4(gatewayIp);
  return {
    base: url.origin,
    auth: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
    gatewayIp
  };
}

function createClient(credentials, fetchImpl) {
  return async (method, relativeUrl, payload, { retries = 0 } = {}) => {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let response;
      try {
        response = await fetchImpl(credentials.base + relativeUrl, {
          method,
          headers: {
            Authorization: credentials.auth,
            ...(payload ? { 'Content-Type': 'application/json' } : {})
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
          signal: AbortSignal.timeout(15000)
        });
      } catch {
        lastError = new Error('AdGuard management endpoint connection failed');
        continue;
      }
      // Never echo the provider free-text body or the credential-bearing
      // request; only bounded status classes are observable.
      if (!response || !Number.isInteger(response.status)) {
        throw new Error('AdGuard returned an invalid HTTP response');
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error('AdGuard authentication rejected (HTTP ' + response.status + ')');
      }
      if (!response.ok) {
        throw new Error('AdGuard API rejected request (HTTP ' + response.status + ')');
      }
      if (method === 'GET') {
        const doc = await response.json().catch(() => null);
        if (doc === null) throw new Error('AdGuard API response failed validation');
        return doc;
      }
      return null;
    }
    throw lastError ?? new Error('AdGuard management endpoint connection failed');
  };
}

export function validateRewriteList(list) {
  if (!Array.isArray(list)) throw new Error('AdGuard rewrite readback missing');
  for (const entry of list) {
    if (!entry || typeof entry.domain !== 'string' || typeof entry.answer !== 'string' ||
        entry.domain.length === 0 || entry.answer.length === 0) {
      throw new Error('AdGuard rewrite readback failed validation');
    }
  }
  return list;
}

async function preflight(call) {
  const status = await call('GET', '/control/status', null, { retries: 2 });
  if (!status || status.running !== true || typeof status.version !== 'string' ||
      status.version.length === 0) {
    throw new Error('AdGuard preflight failed: endpoint is not a running AdGuard Home instance');
  }
  const list = validateRewriteList(await call('GET', '/control/rewrite/list', null, { retries: 2 }));
  return { version: status.version, list };
}

// Exact per-site plan against the reviewed inventory. A managed domain with
// a different answer is an indistinguishable external change: fail closed
// unless a reviewed gateway-change approval authorizes the exact update.
export function planRewrites(expected, list, { approvedGatewayChanges = new Set() } = {}) {
  return expected.map(entry => {
    const matches = list.filter(rewrite => rewrite.domain === entry.domain);
    if (matches.length === 0) return { ...entry, kind: 'create' };
    if (matches.length > 1) return { ...entry, kind: 'blocked', reason: 'duplicate rewrite collision' };
    if (matches[0].answer === entry.answer) return { ...entry, kind: 'noop' };
    if (approvedGatewayChanges.has(entry.domain)) return { ...entry, kind: 'update' };
    return { ...entry, kind: 'blocked', reason: 'existing rewrite answer conflicts with the reviewed inventory' };
  });
}

export async function configureAdguard({
  mode, apiUrl, username, password, gatewayIp,
  environment, siteSelection = 'all', readySites = null,
  fetchImpl = globalThis.fetch, logger = () => {},
  dnsResolver = null,
  planReceipt = null, sourceSha = null, gitopsRevision = null,
  approvals = loaded.approvals, registryHash = loaded.registryHash,
  registry = loaded.registry
}) {
  if (!['plan', 'plan-delete', 'apply', 'reconcile', 'delete', 'verify'].includes(mode)) {
    throw new Error('Unsupported LAN operation: expected plan, plan-delete, apply, reconcile, delete or verify');
  }
  const credentials = validateAdguardInputs({ apiUrl, username, password, gatewayIp });
  const expectedAll = renderLanPlan(registry, gatewayIp);
  if (siteSelection !== 'all') {
    if (!registry.sites.some(site => site.id === siteSelection && site.enabled)) {
      throw new Error('Unregistered or disabled LAN site selection');
    }
  }
  let expected = siteSelection === 'all'
    ? expectedAll
    : expectedAll.filter(entry => entry.site === siteSelection);
  const desiredState = expected;
  // DNS registration requires the canonical GitOps host to be effective
  // (#4588 migration). Sites still on a reviewed legacy alias are reported
  // as pending, never blackholed by a rewrite the gateway cannot route.
  let pendingMigration = [];
  if (readySites !== null && (mode === 'apply' || mode === 'reconcile')) {
    if (!Array.isArray(readySites) || readySites.some(id => typeof id !== 'string')) {
      throw new Error('readySites must be an array of reviewed site IDs');
    }
    pendingMigration = expected.filter(entry => !readySites.includes(entry.site));
    expected = expected.filter(entry => readySites.includes(entry.site));
  }
  const call = createClient(credentials, fetchImpl);
  const { version, list } = await preflight(call);
  logger('adguard preflight verified (version=' + version + ', endpoint hidden)');

  const approvedGatewayChanges = new Set();
  for (const entry of expected) {
    const match = findApproval(approvals, {
      site: entry.site, operation: 'gateway-change', registryHash,
      scope: { fqdn: entry.domain, answerRef: LAN_ANSWER_REF }
    });
    if (match) approvedGatewayChanges.add(entry.domain);
  }
  const operations = planRewrites(expected, list, { approvedGatewayChanges });
  const preserved = list.filter(rewrite =>
    !expected.some(entry => entry.domain === rewrite.domain)).length;

  if (mode === 'plan' || mode === 'verify') {
    const result = {
      kind: 'plan', operations: operations.map(op => ({ site: op.site, domain: op.domain, kind: op.kind })),
      preserved, version
    };
    if (mode === 'verify') {
      result.probes = await lanProbes({ expected, gatewayIp, resolver: dnsResolver });
    }
    if (sourceSha && gitopsRevision) {
      result.receipt = buildPlanReceipt({
        provider: 'adguard', mode: 'plan', environment, site: siteSelection,
        sourceSha, gitopsRevision, registryHash,
        operations: result.operations,
        observedState: list, desiredState: expected,
        runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT
      });
    }
    logger('lan plan sites=' + operations.length + ' preserved_unmanaged=' + preserved +
      ' (gateway IP hidden)');
    return result;
  }

  if (mode === 'plan-delete' || mode === 'delete') {
    return deleteFlow({
      mode, expected, list, call, environment, siteSelection, approvals, registryHash,
      planReceipt, sourceSha, gitopsRevision, logger
    });
  }

  // apply/reconcile: a stale plan fails closed first, then any conflict
  // blocks before writing anything.
  verifyPlanReceipt(planReceipt, {
    provider: 'adguard', environment, site: siteSelection, sourceSha, gitopsRevision,
    registryHash, observedState: list, desiredState
  });
  const blocked = operations.filter(op => op.kind === 'blocked');
  if (blocked.length > 0) {
    throw new Error('AdGuard LAN operation blocked: ' +
      blocked.map(op => op.domain + ' (' + op.reason + ')').join('; '));
  }
  const results = [];
  for (const op of operations) {
    if (op.kind === 'noop') {
      results.push({ site: op.site, domain: op.domain, kind: 'noop', status: 'ok' });
      continue;
    }
    if (op.kind === 'update' && mode === 'reconcile' && !approvedGatewayChanges.has(op.domain)) {
      results.push({ site: op.site, domain: op.domain, kind: 'update', status: 'skipped', reason: 'approval-required' });
      continue;
    }
    try {
      if (op.kind === 'update') {
        // AdGuard Home has no in-place rewrite update; the supported
        // mutation pair is delete followed by add of the exact reviewed answer.
        await call('POST', '/control/rewrite/delete', { domain: op.domain, answer: list.find(r => r.domain === op.domain).answer });
      }
      await call('POST', '/control/rewrite/add', { domain: op.domain, answer: op.answer });
      const readback = validateRewriteList(await call('GET', '/control/rewrite/list'));
      const verified = readback.filter(r => r.domain === op.domain);
      if (verified.length !== 1 || verified[0].answer !== op.answer) {
        throw new Error('post-write readback mismatch');
      }
      results.push({ site: op.site, domain: op.domain, kind: op.kind, status: 'ok' });
      logger('site=' + op.site + ' lan rewrite verified (answer hidden)');
    } catch (error) {
      // Partial failure stays observable per site; successful independent
      // changes are never automatically undone.
      results.push({ site: op.site, domain: op.domain, kind: op.kind, status: 'failed', reason: error.message });
      logger('site=' + op.site + ' lan rewrite FAILED (' + error.message + ')');
    }
  }
  const failed = results.filter(entry => entry.status === 'failed');
  const skipped = results.filter(entry => entry.status === 'skipped');
  const receipt = sourceSha && gitopsRevision ? buildPlanReceipt({
    provider: 'adguard', mode, environment, site: siteSelection,
    sourceSha, gitopsRevision, registryHash,
    operations: results, observedState: list, desiredState,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT
  }) : null;
  if (failed.length > 0) {
    const error = new Error('AdGuard LAN apply partially failed: ' +
      failed.map(entry => entry.domain).join('; ') + ' (successful sites are not rolled back)');
    error.results = results;
    error.receipt = receipt;
    throw error;
  }
  return {
    kind: mode, results, skipped: skipped.length, preserved, receipt,
    pendingMigration: pendingMigration.map(entry => entry.site)
  };
}

async function deleteFlow({
  mode, expected, list, call, environment, siteSelection, approvals, registryHash,
  planReceipt, sourceSha, gitopsRevision, logger
}) {
  if (siteSelection === 'all') {
    throw new Error('LAN deletion requires one explicitly reviewed site, never a bulk selection');
  }
  const entry = expected[0];
  if (!entry) throw new Error('Unregistered or disabled LAN site selection');
  const matches = list.filter(rewrite => rewrite.domain === entry.domain);
  const desiredState = { removal: { domain: entry.domain, answerRef: LAN_ANSWER_REF } };
  const approval = findApproval(approvals, {
    site: siteSelection, operation: 'delete', registryHash,
    scope: { fqdn: entry.domain, answerRef: LAN_ANSWER_REF }
  });
  if (mode === 'plan-delete') {
    const kind = matches.length !== 1 ? 'blocked'
      : matches[0].answer !== entry.answer ? 'blocked'
        : approval ? 'delete' : 'blocked';
    const reason = matches.length !== 1 ? 'rewrite collision or absence'
      : matches[0].answer !== entry.answer ? 'current answer differs from the reviewed inventory'
        : approval ? null : 'deletion requires a reviewed explicit approval';
    const result = { kind, domain: entry.domain, reason, approved: Boolean(approval) };
    if (sourceSha && gitopsRevision) {
      result.receipt = buildPlanReceipt({
        provider: 'adguard', mode: 'plan-delete', environment, site: siteSelection,
        sourceSha, gitopsRevision, registryHash,
        operations: [{ site: siteSelection, domain: entry.domain, kind }],
        observedState: list, desiredState,
        runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT
      });
    }
    return result;
  }
  if (!approval) {
    throw new Error('AdGuard LAN operation blocked: deletion requires a reviewed explicit approval');
  }
  if (matches.length !== 1 || matches[0].answer !== entry.answer) {
    throw new Error('AdGuard LAN operation blocked: current rewrite state differs from the reviewed removal scope');
  }
  verifyPlanReceipt(planReceipt, {
    provider: 'adguard', environment, site: siteSelection, sourceSha, gitopsRevision,
    registryHash, observedState: list, desiredState
  });
  await call('POST', '/control/rewrite/delete', { domain: entry.domain, answer: entry.answer });
  const readback = validateRewriteList(await call('GET', '/control/rewrite/list'));
  if (readback.some(rewrite => rewrite.domain === entry.domain)) {
    throw new Error('AdGuard LAN post-delete readback mismatch');
  }
  logger('site=' + siteSelection + ' lan rewrite removal verified by readback');
  return { kind: 'delete', verified: true };
}

// Independent LAN resolver probes: exact A answer, no public IPv6 fallback.
export async function lanProbes({ expected, gatewayIp, resolver }) {
  if (!resolver) throw new Error('LAN verify requires a validated DNS_RESOLVER endpoint');
  const probes = [];
  for (const entry of expected) {
    const probe = { domain: entry.domain, a: null, aaaa: null, status: 'ok' };
    try {
      const addresses = await resolver.resolve4(entry.domain);
      probe.a = Array.isArray(addresses) && addresses.length === 1 && addresses[0] === gatewayIp;
    } catch {
      probe.a = false;
    }
    try {
      const addresses6 = await resolver.resolve6(entry.domain);
      probe.aaaa = Array.isArray(addresses6) && addresses6.length === 0;
    } catch (error) {
      // NODATA/ENOTFOUND is the expected absence of an IPv6 fallback.
      probe.aaaa = ['ENODATA', 'ENOTFOUND'].includes(error?.code) ? true : false;
    }
    if (!probe.a || !probe.aaaa) probe.status = 'failed';
    probes.push(probe);
  }
  return probes;
}

export function validateResolverAddress(address) {
  if (typeof address !== 'string') throw new Error('DNS_RESOLVER must be a validated internal resolver IPv4');
  return validateGatewayIpv4(address);
}

function readReceiptFile() {
  const file = process.env.SITE_PLAN_RECEIPT;
  if (!file) throw new Error('SITE_PLAN_RECEIPT must reference the reviewed plan receipt artifact');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cli() {
  const mode = process.argv[2];
  const needsReceipt = mode === 'apply' || mode === 'reconcile' || mode === 'delete';
  const sourceSha = process.env.SOURCE_SHA;
  const gitopsRevision = process.env.GITOPS_REVISION;
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '') || !/^[0-9a-f]{40}$/.test(gitopsRevision ?? '')) {
    throw new Error('SOURCE_SHA and GITOPS_REVISION must be exact 40-hex revisions');
  }
  let dnsResolver = null;
  if (mode === 'verify') {
    const address = validateResolverAddress(process.env.DNS_RESOLVER);
    dnsResolver = new dns.Resolver();
    dnsResolver.setServers([address]);
  }
  return configureAdguard({
    mode,
    apiUrl: process.env.ADGUARD_API_URL,
    username: process.env.ADGUARD_USERNAME,
    password: process.env.ADGUARD_PASSWORD,
    gatewayIp: process.env.LAN_GATEWAY_IP,
    environment: process.env.TARGET_ENVIRONMENT,
    siteSelection: process.env.SITE_SELECTION || 'all',
    readySites: process.env.SITE_READY_SITES ? JSON.parse(process.env.SITE_READY_SITES) : null,
    dnsResolver,
    planReceipt: needsReceipt ? readReceiptFile() : null,
    sourceSha, gitopsRevision,
    logger: line => console.log(line)
  }).then(result => {
    if (result?.receipt && process.env.SITE_PLAN_OUT) {
      fs.writeFileSync(process.env.SITE_PLAN_OUT, JSON.stringify(result.receipt, null, 2) + '\n', { mode: 0o600 });
      console.log('sanitized LAN receipt written (no provider values)');
    }
    if (result?.results) {
      const failed = result.results.filter(entry => entry.status === 'failed').length;
      console.log('LAN_RESULT_V1 total=' + result.results.length + ' failed=' + failed +
        ' skipped=' + (result.skipped ?? 0));
    }
    if (result?.probes) {
      const failed = result.probes.filter(entry => entry.status === 'failed').length;
      console.log('LAN_PROBES_V1 total=' + result.probes.length + ' failed=' + failed);
      if (failed > 0) process.exitCode = 1;
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  cli().catch(error => {
    console.error('AdGuard LAN configuration failed: ' + error.message);
    if (error.results) {
      for (const entry of error.results) {
        console.error('LAN_SITE_RESULT_V1 site=' + entry.site + ' status=' + entry.status +
          ' kind=' + entry.kind + (entry.reason ? ' reason=' + entry.reason : ''));
      }
    }
    process.exitCode = 1;
  });
}

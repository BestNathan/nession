#!/usr/bin/env node
// Exact-head provider contract tests (#3963 baseline, #4589 SC-02): plan is
// read-only, private/unknown sites never reach Cloudflare, approved public
// MCP maintenance is receipt-bound and readback-verified, and conflicts,
// wrong zone, stale plans and unowned/shared/wildcard deletion fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSite, validateOriginIpv4, validateInputs, cidrContainsIpv4,
  planRecord, configureSite, buildResultReceipt
} from './configure-cloudflare-site.mjs';
import { loadRegistry, buildPlanReceipt } from './site-registry/site-registry.mjs';

const loaded = loadRegistry();
const zoneId = 'a'.repeat(32);
const recordId = 'b'.repeat(32);
const token = 'test-secret-api-token-never-log-this';
const ip = '8.8.4.4';
const siteId = 'staging-mcp';
const site = getSite(siteId);
const marker = site.comment;
const sourceSha = '1'.repeat(40);
const gitopsRevision = '2'.repeat(40);

function record(extra = {}) {
  return {
    id: recordId, name: site.hostname, type: 'A', content: ip,
    proxied: true, ttl: 1, comment: marker, ...extra
  };
}

function approval(operation, scope) {
  return {
    version: 1, issue: 4589,
    approvals: [{
      id: 'test-' + operation, site: siteId, operation, scope,
      issue: 4589, approvedBy: 'operator', approvedAt: '2026-11-27',
      registryHash: loaded.registryHash
    }]
  };
}

function fakeCloudflare({ records = [], zone = site.zone, status = 'active',
  edgeCidrs = ['104.16.0.0/13', '172.64.0.0/13'],
  failStatus = null } = {}) {
  const state = { records: structuredClone(records), requests: [] };
  const json = (result, resultInfo) =>
    new Response(JSON.stringify({
      success: true, result,
      ...(resultInfo ? { result_info: resultInfo } : {})
    }), { status: 200 });
  const fetchImpl = async (url, request) => {
    const uri = new URL(url);
    state.requests.push({
      method: request.method,
      pathname: uri.pathname,
      search: uri.search,
      headers: request.headers,
      body: request.body ? JSON.parse(request.body) : null
    });
    if (failStatus !== null) return new Response('{}', { status: failStatus });
    if (request.method === 'GET' && uri.pathname === '/client/v4/zones/' + zoneId) {
      return json({ id: zoneId, name: zone, status });
    }
    if (request.method === 'GET' && uri.pathname === '/client/v4/ips') {
      return json({ ipv4_cidrs: edgeCidrs });
    }
    const prefix = '/client/v4/zones/' + zoneId + '/dns_records';
    if (request.method === 'GET' && uri.pathname === prefix) {
      assert.equal(uri.searchParams.get('name'), site.hostname);
      assert.equal(uri.searchParams.get('per_page'), '100');
      return json(structuredClone(state.records), {
        total_pages: 1, total_count: state.records.length
      });
    }
    if (request.method === 'POST' && uri.pathname === prefix) {
      const created = { id: recordId, ...JSON.parse(request.body) };
      state.records.push(created);
      return json(created);
    }
    if (request.method === 'PATCH' && uri.pathname === prefix + '/' + recordId) {
      const index = state.records.findIndex(entry => entry.id === recordId);
      assert.notEqual(index, -1);
      state.records[index] = { ...state.records[index], ...JSON.parse(request.body) };
      return json(state.records[index]);
    }
    if (request.method === 'DELETE' && uri.pathname === prefix + '/' + recordId) {
      const index = state.records.findIndex(entry => entry.id === recordId);
      assert.notEqual(index, -1);
      state.records.splice(index, 1);
      return json({ id: recordId });
    }
    throw new Error('Unexpected network request: ' + request.method + ' ' + uri.pathname);
  };
  return { state, fetchImpl };
}

function params(fake, overrides = {}) {
  return {
    mode: 'apply', siteId, environment: 'staging',
    apiToken: token, zoneId, originIpv4: ip,
    sourceSha, gitopsRevision,
    fetchImpl: fake.fetchImpl, ...overrides
  };
}

async function planThenApply(fake, overrides = {}) {
  const plan = await configureSite(params(fake, { mode: 'plan', ...overrides }));
  assert.ok(plan.receipt, 'plan must emit a sanitized receipt');
  return configureSite(params(fake, { mode: 'apply', planReceipt: plan.receipt, ...overrides }));
}

test('registry rejects arbitrary domains/environments and identifies first-level site', () => {
  assert.equal(site.hostname, 'staging-mcp-nession.bestnathan.top');
  assert.equal(site.zone, 'bestnathan.top');
  assert.equal(site.proxied, true);
  assert.throws(() => getSite('production'), /Unregistered site/);
  assert.throws(() => getSite('__proto__'), /Unregistered site/);
});

test('private and unknown sites fail before any Cloudflare request', async () => {
  for (const [id, pattern] of [
    ['staging-server', /Private site/],
    ['production-agent', /Private site/],
    ['ghost-site', /Unregistered site/]
  ]) {
    const fake = fakeCloudflare();
    await assert.rejects(() => configureSite(params(fake, { siteId: id })), pattern);
    assert.equal(fake.state.requests.length, 0, id);
  }
  const disabled = fakeCloudflare();
  await assert.rejects(() => configureSite(params(disabled, {
    siteId: 'production-mcp', environment: 'production'
  })), /not activated/);
  assert.equal(disabled.state.requests.length, 0);
});

test('strict provider input and public origin IPv4 validation', () => {
  assert.equal(validateOriginIpv4(ip), ip);
  for (const invalid of [
    '', 'private.local', '2001:db8::1', '10.1.2.3', '192.168.1.1',
    '172.19.1.2', '100.65.1.1', '127.0.0.1', '169.254.5.5',
    '192.0.2.8', '198.51.100.10', '203.0.113.2', '224.0.0.1'
  ]) {
    assert.throws(() => validateOriginIpv4(invalid), undefined, invalid);
  }
  assert.throws(() => validateInputs({ apiToken: '', zoneId, originIpv4: ip }));
  assert.throws(() => validateInputs({ apiToken: token, zoneId: 'bad', originIpv4: ip }));
  assert.equal(validateInputs({ apiToken: token, zoneId, originIpv4: ip }).originIpv4, ip);
  assert.equal(cidrContainsIpv4('104.16.0.0/13', '104.21.15.20'), true);
  assert.equal(cidrContainsIpv4('172.64.0.0/13', '172.67.161.8'), true);
  assert.equal(cidrContainsIpv4('104.16.0.0/13', ip), false);
  assert.throws(() => cidrContainsIpv4('bad', ip), /Invalid Cloudflare IPv4/);
});

test('plan is strictly read-only and does not emit token or origin IP', async () => {
  const fake = fakeCloudflare();
  const output = [];
  const result = await configureSite(params(fake, {
    mode: 'plan', logger: line => output.push(line)
  }));
  assert.equal(result.kind, 'create');
  assert.equal(result.approvalRequired, 'public-activate');
  assert.equal(result.approved, true, 'recorded #3963 lineage authorizes the existing reviewed activation');
  assert.deepEqual(fake.state.requests.map(req => req.method), ['GET', 'GET', 'GET']);
  assert.ok(output.join('').includes('dns=create'));
  assert.equal(output.join('').includes(token), false);
  assert.equal(output.join('').includes(ip), false);
  const serialized = JSON.stringify(result.receipt);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(ip), false);
  assert.equal(result.receipt.sourceSha, sourceSha);
  assert.equal(result.receipt.gitopsRevision, gitopsRevision);
});

test('apply creates one record and reads back exact provider state', async () => {
  const fake = fakeCloudflare();
  const plan = await planThenApply(fake);
  assert.deepEqual(plan, { kind: 'create', verified: true });
  assert.equal(fake.state.records.length, 1);
  assert.deepEqual(fake.state.requests.map(req => req.method),
    ['GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'POST', 'GET']);
  assert.deepEqual(fake.state.requests[6].body,
    { name: site.hostname, type: 'A', content: ip, proxied: true,
      ttl: 1, comment: marker });
  assert.ok(fake.state.requests.every(req =>
    req.headers.Authorization === 'Bearer ' + token));
});

test('apply without a reviewed plan receipt fails closed before mutation', async () => {
  const fake = fakeCloudflare();
  await assert.rejects(() => configureSite(params(fake)), /missing plan receipt/);
  assert.ok(fake.state.requests.every(req => req.method === 'GET'));
});

test('stale plan, changed desired state and revision drift block apply', async () => {
  const stale = fakeCloudflare();
  const plan = await configureSite(params(stale, { mode: 'plan' }));
  stale.state.records.push(record({ content: '1.1.1.1' }));
  await assert.rejects(() => configureSite(params(stale, { planReceipt: plan.receipt })),
    /provider state changed since plan/);
  assert.ok(stale.state.requests.every(req => req.method === 'GET'));

  const desired = fakeCloudflare();
  const plan2 = await configureSite(params(desired, { mode: 'plan' }));
  await assert.rejects(() => configureSite(params(desired, {
    planReceipt: plan2.receipt, originIpv4: '1.1.1.1'
  })), /desired state changed since plan/);

  const drift = fakeCloudflare();
  const plan3 = await configureSite(params(drift, { mode: 'plan' }));
  for (const [override, pattern] of [
    [{ sourceSha: '3'.repeat(40) }, /source SHA changed/],
    [{ gitopsRevision: '4'.repeat(40) }, /GitOps revision changed/],
    [{ registryHash: '5'.repeat(64) }, /registry changed/],
    [{ environment: 'production' }, /Environment identity mismatch/]
  ]) {
    await assert.rejects(() => configureSite(params(drift, {
      planReceipt: plan3.receipt, ...override
    })), pattern);
  }
  assert.ok(drift.state.requests.every(req => req.method === 'GET'));
});

test('apply is idempotent and does not rewrite an exact existing record', async () => {
  const fake = fakeCloudflare({ records: [record()] });
  const result = await configureSite(params(fake));
  assert.equal(result.kind, 'noop');
  assert.deepEqual(fake.state.requests.map(req => req.method), ['GET', 'GET', 'GET']);
});

test('owned maintenance PATCH stays within the exact registered record', async () => {
  const fake = fakeCloudflare({ records: [record({ proxied: false })] });
  const result = await planThenApply(fake);
  assert.deepEqual(result, { kind: 'update', verified: true });
  assert.equal(fake.state.requests[6].method, 'PATCH');
  assert.equal(fake.state.requests[6].pathname,
    '/client/v4/zones/' + zoneId + '/dns_records/' + recordId);
  assert.equal(fake.state.records[0].content, ip);
  assert.equal(fake.state.records[0].proxied, true);
});

test('origin change requires a reviewed explicit approval', async () => {
  const fake = fakeCloudflare({ records: [record({ content: '1.1.1.1' })] });
  const plan = await configureSite(params(fake, { mode: 'plan' }));
  assert.equal(plan.approvalRequired, 'origin-change');
  assert.equal(plan.approved, false);
  await assert.rejects(() => configureSite(params(fake, { planReceipt: plan.receipt })),
    /origin-change requires a reviewed explicit approval/);
  assert.ok(fake.state.requests.every(req => req.method === 'GET'));

  const approved = fakeCloudflare({ records: [record({ content: '1.1.1.1' })] });
  const plan2 = await configureSite(params(approved, { mode: 'plan' }));
  const result = await configureSite(params(approved, {
    planReceipt: plan2.receipt,
    approvals: approval('origin-change', { fqdn: site.hostname, originRef: 'CLOUDFLARE_ORIGIN_IPV4' })
  }));
  assert.deepEqual(result, { kind: 'update', verified: true });
  assert.equal(approved.state.records[0].content, ip);
});

test('reconcile skips unapproved sensitive work instead of mutating or failing hard', async () => {
  const fake = fakeCloudflare({ records: [record({ content: '1.1.1.1' })] });
  const plan = await configureSite(params(fake, { mode: 'plan' }));
  const result = await configureSite(params(fake, {
    mode: 'reconcile', planReceipt: plan.receipt
  }));
  assert.deepEqual(result, { kind: 'skipped', reason: 'approval-required', operation: 'origin-change' });
  assert.ok(fake.state.requests.every(req => req.method === 'GET'));
});

test('unowned changed records, duplicates and address collisions block mutation', async () => {
  for (const records of [
    [record({ comment: 'user-managed', content: '1.1.1.1' })],
    [record(), record({ id: 'c'.repeat(32) })],
    [record(), { ...record(), id: 'd'.repeat(32), type: 'AAAA' }],
    [{ ...record(), type: 'CNAME', content: 'old.example.com' }]
  ]) {
    const fake = fakeCloudflare({ records });
    await assert.rejects(() => configureSite(params(fake)), /blocked/);
    assert.equal(fake.state.requests.some(req => req.method !== 'GET'), false);
  }
});

test('matching unmanaged record is untouched, never silently adopted', async () => {
  const fake = fakeCloudflare({ records: [record({ comment: 'manual owner' })] });
  const result = await configureSite(params(fake));
  assert.deepEqual(result, { kind: 'noop', recordId, owned: false });
  assert.ok(fake.state.requests.every(req => req.method === 'GET'));
});

test('wrong zone/environment and Cloudflare edge IP are fail-closed', async () => {
  await assert.rejects(() => configureSite(params(fakeCloudflare(), {
    environment: 'production'
  })), /Environment identity mismatch/);
  await assert.rejects(() => configureSite(params(fakeCloudflare({ zone: 'other.zone' }))),
    /Zone identity/);
  await assert.rejects(() => configureSite(params(fakeCloudflare(), {
    originIpv4: '104.21.15.20'
  })), /Cloudflare edge/);
  await assert.rejects(() => configureSite(params(fakeCloudflare(), {
    originIpv4: '172.67.161.8'
  })), /Cloudflare edge/);
});

test('provider network failure is sanitized and does not mutate DNS', async () => {
  const fake = fakeCloudflare({ failStatus: 403 });
  await assert.rejects(() => configureSite(params(fake)), /HTTP 403/);
  assert.equal(fake.state.requests.length, 1);
  assert.ok(fake.state.requests.every(req => req.method === 'GET'));
});

test('post-write record readback mismatch fails rather than claiming success', async () => {
  const fake = fakeCloudflare();
  const plan = await configureSite(params(fake, { mode: 'plan' }));
  const fetchImpl = fake.fetchImpl;
  let listCount = 0;
  fake.fetchImpl = async (url, req) => {
    const u = new URL(url);
    const response = await fetchImpl(url, req);
    if (req.method === 'GET' && u.pathname.endsWith('/dns_records')) {
      listCount++;
      if (listCount === 2) {
        return new Response(JSON.stringify({
          success: true, result: [],
          result_info: { total_pages: 1, total_count: 0 }
        }), { status: 200 });
      }
    }
    return response;
  };
  await assert.rejects(() => configureSite(params(fake, { planReceipt: plan.receipt })),
    /post-write readback mismatch/);
});

test('planRecord never accepts records returned for a different FQDN', () => {
  assert.throws(() => planRecord(site, [
    record({ name: 'staging.mcp.nession.bestnathan.top' })
  ], ip), /escaped the registered hostname/);
});

test('deletion requires an exact reviewed approval, fresh state and readback', async () => {
  const deleteApproval = approval('delete', {
    fqdn: site.hostname, recordId, recordType: 'A'
  });
  const fake = fakeCloudflare({ records: [record()] });
  const plan = await configureSite(params(fake, {
    mode: 'plan-delete', approvals: deleteApproval
  }));
  assert.equal(plan.kind, 'delete');
  assert.equal(plan.approved, true);
  const result = await configureSite(params(fake, {
    mode: 'delete', planReceipt: plan.receipt, approvals: deleteApproval
  }));
  assert.deepEqual(result, { kind: 'delete', verified: true });
  assert.equal(fake.state.records.length, 0);
  const methods = fake.state.requests.map(req => req.method);
  assert.ok(methods.includes('DELETE'));
  assert.equal(methods[methods.length - 1], 'GET', 'independent post-delete readback');
});

test('unapproved, unowned, colliding and stale deletions are blocked', async () => {
  const fake = fakeCloudflare({ records: [record()] });
  await assert.rejects(() => configureSite(params(fake, { mode: 'delete' })),
    /reviewed explicit approval/);
  assert.ok(fake.state.requests.every(req => req.method === 'GET'));

  const unowned = fakeCloudflare({ records: [record({ comment: 'manual owner' })] });
  await assert.rejects(() => configureSite(params(unowned, {
    mode: 'delete',
    approvals: approval('delete', { fqdn: site.hostname, recordId, recordType: 'A' })
  })), /another owner/);

  const collision = fakeCloudflare({ records: [record(), record({ id: 'c'.repeat(32) })] });
  await assert.rejects(() => configureSite(params(collision, {
    mode: 'delete',
    approvals: approval('delete', { fqdn: site.hostname, recordId, recordType: 'A' })
  })), /collision/);

  const wrongId = fakeCloudflare({ records: [record()] });
  await assert.rejects(() => configureSite(params(wrongId, {
    mode: 'delete',
    approvals: approval('delete', { fqdn: site.hostname, recordId: 'c'.repeat(32), recordType: 'A' })
  })), /reviewed explicit approval/);

  const stale = fakeCloudflare({ records: [record()] });
  const plan = await configureSite(params(stale, {
    mode: 'plan-delete',
    approvals: approval('delete', { fqdn: site.hostname, recordId, recordType: 'A' })
  }));
  stale.state.records[0].content = '1.1.1.1';
  await assert.rejects(() => configureSite(params(stale, {
    mode: 'delete', planReceipt: plan.receipt,
    approvals: approval('delete', { fqdn: site.hostname, recordId, recordType: 'A' })
  })), /provider state changed since plan/);
  assert.ok(stale.state.requests.every(req => req.method === 'GET'));

  const escaped = fakeCloudflare({ records: [{ ...record(), type: 'CNAME' }] });
  await assert.rejects(() => configureSite(params(escaped, {
    mode: 'delete',
    approvals: approval('delete', { fqdn: site.hostname, recordId, recordType: 'CNAME' })
  })), /record identity escaped/);
});

test('mutation result receipt binds the reviewed plan and carries no secrets', () => {
  const secretIp = '203.0.113.77';
  const token = 'super-secret-provider-token-value';
  const plan = buildPlanReceipt({
    provider: 'cloudflare', mode: 'plan', environment: 'staging', site: siteId,
    sourceSha, gitopsRevision, registryHash: loaded.registryHash,
    operations: [{ site: siteId, kind: 'create' }],
    observedState: { records: [], auth: token },
    desiredState: { content: secretIp },
    runId: '123', runAttempt: '1'
  });
  const receipt = buildResultReceipt({
    mode: 'apply', environment: 'staging', site: siteId,
    sourceSha, gitopsRevision, registryHash: loaded.registryHash,
    planReceipt: plan, result: { kind: 'create', verified: true }
  });
  assert.equal(receipt.receipt, 'NESSION_SITE_RESULT_V1');
  assert.equal(receipt.planHash, plan.planHash);
  assert.equal(receipt.operation, 'create');
  assert.equal(receipt.verified, true);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(secretIp), false);
  assert.equal(serialized.includes(token), false);
  assert.throws(() => buildResultReceipt({
    mode: 'apply', environment: 'staging', site: siteId,
    sourceSha, gitopsRevision, registryHash: loaded.registryHash,
    planReceipt: null, result: { kind: 'create', verified: true }
  }), /reviewed plan receipt/);
});

test('post-delete readback mismatch fails rather than claiming success', async () => {
  const fake = fakeCloudflare({ records: [record()] });
  const deleteApproval = approval('delete', { fqdn: site.hostname, recordId, recordType: 'A' });
  const plan = await configureSite(params(fake, { mode: 'plan-delete', approvals: deleteApproval }));
  const fetchImpl = fake.fetchImpl;
  let listCount = 0;
  fake.fetchImpl = async (url, req) => {
    const u = new URL(url);
    if (req.method === 'GET' && u.pathname.endsWith('/dns_records')) {
      listCount++;
      if (listCount === 2) {
        return new Response(JSON.stringify({
          success: true, result: [record()],
          result_info: { total_pages: 1, total_count: 1 }
        }), { status: 200 });
      }
    }
    return fetchImpl(url, req);
  };
  await assert.rejects(() => configureSite(params(fake, {
    mode: 'delete', planReceipt: plan.receipt, approvals: deleteApproval
  })), /post-delete readback mismatch/);
});

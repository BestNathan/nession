#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSite, validateOriginIpv4, validateInputs, cidrContainsIpv4,
  planRecord, configureSite
} from './configure-cloudflare-site.mjs';

const zoneId = 'a'.repeat(32);
const recordId = 'b'.repeat(32);
const token = 'test-secret-api-token-never-log-this';
const ip = '8.8.4.4';
const siteId = 'staging-mcp';
const site = getSite(siteId);
const marker = site.comment;

function record(extra = {}) {
  return {
    id: recordId, name: site.hostname, type: 'A', content: ip,
    proxied: true, ttl: 1, comment: marker, ...extra
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
    throw new Error('Unexpected network request: ' + request.method + ' ' + uri.pathname);
  };
  return { state, fetchImpl };
}

function params(fake, overrides = {}) {
  return {
    mode: 'apply', siteId, environment: 'staging',
    apiToken: token, zoneId, originIpv4: ip,
    fetchImpl: fake.fetchImpl, ...overrides
  };
}

test('registry rejects arbitrary domains/environments and identifies first-level site', () => {
  assert.equal(site.hostname, 'staging-mcp-nession.bestnathan.top');
  assert.equal(site.zone, 'bestnathan.top');
  assert.equal(site.proxied, true);
  assert.throws(() => getSite('production'), /Unregistered site/);
  assert.throws(() => getSite('__proto__'), /Unregistered site/);
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
  assert.deepEqual(fake.state.requests.map(req => req.method), ['GET','GET','GET']);
  assert.ok(output.join('').includes('dns=create'));
  assert.equal(output.join('').includes(token), false);
  assert.equal(output.join('').includes(ip), false);
});

test('apply creates one record and reads back exact provider state', async () => {
  const fake = fakeCloudflare();
  const plan = await configureSite(params(fake));
  assert.deepEqual(plan, { kind: 'create', verified: true });
  assert.equal(fake.state.records.length, 1);
  assert.deepEqual(fake.state.requests.map(req => req.method),
    ['GET','GET','GET','POST','GET']);
  assert.deepEqual(fake.state.requests[3].body,
    { name: site.hostname, type: 'A', content: ip, proxied: true,
      ttl: 1, comment: marker });
  assert.ok(fake.state.requests.every(req =>
    req.headers.Authorization === 'Bearer ' + token));
});

test('apply is idempotent and does not rewrite an exact existing record', async () => {
  const fake = fakeCloudflare({ records: [record()] });
  const result = await configureSite(params(fake));
  assert.equal(result.kind, 'noop');
  assert.deepEqual(fake.state.requests.map(req => req.method), ['GET','GET','GET']);
});

test('owned DNS changes may be PATCHed only within exact registered record', async () => {
  const fake = fakeCloudflare({ records: [record({ content: '1.1.1.1', proxied: false })] });
  const result = await configureSite(params(fake));
  assert.deepEqual(result, { kind: 'update', verified: true });
  assert.equal(fake.state.requests[3].method, 'PATCH');
  assert.equal(fake.state.requests[3].pathname,
    '/client/v4/zones/' + zoneId + '/dns_records/' + recordId);
  assert.equal(fake.state.records[0].content, ip);
  assert.equal(fake.state.records[0].proxied, true);
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
  await assert.rejects(() => configureSite(params(fake)), /post-write readback mismatch/);
});

test('planRecord never accepts records returned for a different FQDN', () => {
  assert.throws(() => planRecord(site, [
    record({ name: 'staging.mcp.nession.bestnathan.top' })
  ], ip), /escaped the registered hostname/);
});

#!/usr/bin/env node
// Deterministic LAN adapter contract tests (#4589 SC-03 host set/preservation,
// SC-05 nonmutating plan, repeat-apply noop, stale/ownership/credential/VPN
// failure blocking, observable partial failure and cleanup-safe receipts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAdguardInputs, validateRewriteList, planRewrites,
  configureAdguard, lanProbes, validateResolverAddress
} from './configure-adguard-dns.mjs';
import { loadRegistry, renderLanPlan } from './site-registry/site-registry.mjs';

const loaded = loadRegistry();
const gateway = '192.168.2.10';
const username = 'ci-adguard-user';
const password = 'test-secret-adguard-password-never-log';
const apiUrl = 'https://192.168.2.53';
const sourceSha = '1'.repeat(40);
const gitopsRevision = '2'.repeat(40);
const expectedPlan = renderLanPlan(loaded.registry, gateway);
const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

function fakeAdguard({ rewrites = [], running = true, version = 'v0.107.50',
  failStatus = null, failAddFor = null, badAuth = false } = {}) {
  const state = { rewrites: structuredClone(rewrites), requests: [] };
  const json = value => new Response(JSON.stringify(value), { status: 200 });
  const fetchImpl = async (url, request) => {
    const uri = new URL(url);
    state.requests.push({
      method: request.method, pathname: uri.pathname,
      headers: request.headers,
      body: request.body ? JSON.parse(request.body) : null
    });
    if (badAuth || request.headers.Authorization !== auth) {
      return new Response('denied', { status: 401 });
    }
    if (failStatus !== null) return new Response('{}', { status: failStatus });
    if (request.method === 'GET' && uri.pathname === '/control/status') {
      return json({ version, running });
    }
    if (request.method === 'GET' && uri.pathname === '/control/rewrite/list') {
      return json(structuredClone(state.rewrites));
    }
    if (request.method === 'POST' && uri.pathname === '/control/rewrite/add') {
      const entry = JSON.parse(request.body);
      if (failAddFor === entry.domain) return new Response('write failed', { status: 500 });
      if (state.rewrites.some(rewrite => rewrite.domain === entry.domain)) {
        return new Response('duplicate', { status: 400 });
      }
      state.rewrites.push(entry);
      return new Response('', { status: 200 });
    }
    if (request.method === 'POST' && uri.pathname === '/control/rewrite/delete') {
      const entry = JSON.parse(request.body);
      const index = state.rewrites.findIndex(rewrite =>
        rewrite.domain === entry.domain && rewrite.answer === entry.answer);
      if (index === -1) return new Response('not found', { status: 400 });
      state.rewrites.splice(index, 1);
      return new Response('', { status: 200 });
    }
    throw new Error('Unexpected AdGuard request: ' + request.method + ' ' + uri.pathname);
  };
  return { state, fetchImpl };
}

function params(fake, overrides = {}) {
  return {
    mode: 'apply', apiUrl, username, password, gatewayIp: gateway,
    environment: 'staging', sourceSha, gitopsRevision,
    fetchImpl: fake.fetchImpl, ...overrides
  };
}

async function planThenApply(fake, overrides = {}) {
  const plan = await configureAdguard(params(fake, { mode: 'plan', ...overrides }));
  assert.ok(plan.receipt);
  return configureAdguard(params(fake, { mode: 'apply', planReceipt: plan.receipt, ...overrides }));
}

function approval(site, operation, scope) {
  return {
    version: 1, issue: 4589,
    approvals: [{
      id: 'test-' + operation + '-' + site, site, operation, scope,
      issue: 4589, approvedBy: 'operator', approvedAt: '2026-11-27',
      registryHash: loaded.registryHash
    }]
  };
}

test('management endpoint, credentials and gateway inputs are strictly validated', () => {
  for (const badUrl of [
    'http://192.168.2.53', 'https://user:pass@192.168.2.53',
    'https://192.168.2.53/control', 'https://192.168.2.53/?x=1',
    'https://8.8.4.4', 'not-a-url'
  ]) {
    assert.throws(() => validateAdguardInputs({
      apiUrl: badUrl, username, password, gatewayIp: gateway
    }), /ADGUARD_API_URL|RFC1918/, badUrl);
  }
  assert.throws(() => validateAdguardInputs({ apiUrl, username: '', password, gatewayIp: gateway }),
    /ADGUARD_USERNAME/);
  assert.throws(() => validateAdguardInputs({ apiUrl, username, password: '', gatewayIp: gateway }),
    /ADGUARD_USERNAME/);
  assert.throws(() => validateAdguardInputs({ apiUrl, username, password, gatewayIp: '8.8.4.4' }),
    /RFC1918/);
  const valid = validateAdguardInputs({ apiUrl, username, password, gatewayIp: gateway });
  assert.equal(valid.base, apiUrl);
  assert.equal(valid.auth, auth);
  assert.throws(() => validateResolverAddress('8.8.8.8'), /RFC1918/);
  assert.equal(validateResolverAddress('192.168.2.53'), '192.168.2.53');
  assert.throws(() => validateRewriteList([{ domain: 'x' }]), /failed validation/);
  assert.throws(() => validateRewriteList(null), /readback missing/);
});

test('plan is read-only and renders the exact enabled canonical host set', async () => {
  const fake = fakeAdguard({ rewrites: [
    { domain: 'nession.nhome.local', answer: '192.168.2.99' },
    { domain: 'other.bestnathan.top', answer: '192.168.2.99' },
    { domain: '*.apps.example.com', answer: '192.168.2.99' }
  ] });
  const output = [];
  const plan = await configureAdguard(params(fake, { mode: 'plan', logger: line => output.push(line) }));
  assert.deepEqual(plan.operations.map(op => op.domain), expectedPlan.map(entry => entry.domain));
  assert.ok(plan.operations.every(op => op.kind === 'create'));
  assert.equal(plan.preserved, 3);
  assert.ok(fake.state.requests.every(req => req.method === 'GET'));
  const serialized = JSON.stringify(plan) + output.join('');
  assert.equal(serialized.includes(password), false);
  assert.equal(serialized.includes(gateway), false);
  assert.equal(serialized.includes(username), false);
  assert.equal(plan.receipt.provider, 'adguard');
});

test('apply creates every enabled rewrite with independent readback and preserves unrelated records', async () => {
  const unrelated = [
    { domain: 'nession.nhome.local', answer: '192.168.2.99' },
    { domain: 'manual.bestnathan.top', answer: '192.168.2.99' }
  ];
  const fake = fakeAdguard({ rewrites: unrelated });
  const result = await planThenApply(fake);
  assert.equal(result.results.length, expectedPlan.length);
  assert.ok(result.results.every(entry => entry.status === 'ok' && entry.kind === 'create'));
  for (const entry of expectedPlan) {
    assert.deepEqual(fake.state.rewrites.find(rewrite => rewrite.domain === entry.domain),
      { domain: entry.domain, answer: gateway });
  }
  for (const entry of unrelated) {
    assert.deepEqual(fake.state.rewrites.find(rewrite => rewrite.domain === entry.domain), entry);
  }
  assert.equal(fake.state.rewrites.length, expectedPlan.length + unrelated.length);
});

test('repeat apply is a noop and matching unmanaged rewrites are never adopted or rewritten', async () => {
  const fake = fakeAdguard({ rewrites: expectedPlan.map(entry => ({ domain: entry.domain, answer: entry.answer })) });
  const result = await planThenApply(fake);
  assert.ok(result.results.every(entry => entry.kind === 'noop' && entry.status === 'ok'));
  assert.ok(fake.state.requests.every(req => req.method === 'GET'));
});

test('conflicting answers and duplicate collisions fail closed before any write', async () => {
  const conflict = fakeAdguard({ rewrites: [
    { domain: 'staging-nession.bestnathan.top', answer: '192.168.2.99' }
  ] });
  await assert.rejects(() => planThenApply(conflict), /conflicts with the reviewed inventory/);
  assert.ok(conflict.state.requests.every(req => req.method === 'GET'));

  const duplicate = fakeAdguard({ rewrites: [
    { domain: 'staging-nession.bestnathan.top', answer: gateway },
    { domain: 'staging-nession.bestnathan.top', answer: gateway }
  ] });
  await assert.rejects(() => planThenApply(duplicate), /duplicate rewrite collision/);
  assert.ok(duplicate.state.requests.every(req => req.method === 'GET'));
});

test('gateway change updates only with a reviewed per-site approval', async () => {
  const scope = { fqdn: 'staging-nession.bestnathan.top', answerRef: 'LAN_GATEWAY_IP' };
  const fake = fakeAdguard({ rewrites: [
    { domain: 'staging-nession.bestnathan.top', answer: '192.168.2.99' }
  ] });
  const plan = await configureAdguard(params(fake, {
    mode: 'plan', siteSelection: 'staging-server',
    approvals: approval('staging-server', 'gateway-change', scope)
  }));
  assert.equal(plan.operations[0].kind, 'update');
  const result = await configureAdguard(params(fake, {
    mode: 'apply', siteSelection: 'staging-server', planReceipt: plan.receipt,
    approvals: approval('staging-server', 'gateway-change', scope)
  }));
  assert.equal(result.results[0].kind, 'update');
  assert.equal(result.results[0].status, 'ok');
  assert.deepEqual(fake.state.rewrites.find(r => r.domain === scope.fqdn),
    { domain: scope.fqdn, answer: gateway });
  const posts = fake.state.requests.filter(req => req.method === 'POST');
  assert.deepEqual(posts.map(req => req.pathname),
    ['/control/rewrite/delete', '/control/rewrite/add']);
});

test('stale plan, changed desired gateway and revision drift block LAN apply', async () => {
  const stale = fakeAdguard();
  const plan = await configureAdguard(params(stale, { mode: 'plan' }));
  stale.state.rewrites.push({ domain: 'staging-nession.bestnathan.top', answer: '192.168.2.99' });
  await assert.rejects(() => configureAdguard(params(stale, { planReceipt: plan.receipt })),
    /provider state changed since plan/);
  assert.ok(stale.state.requests.every(req => req.method === 'GET'));

  const desired = fakeAdguard();
  const plan2 = await configureAdguard(params(desired, { mode: 'plan' }));
  await assert.rejects(() => configureAdguard(params(desired, {
    planReceipt: plan2.receipt, gatewayIp: '192.168.2.11'
  })), /desired state changed since plan/);

  const drift = fakeAdguard();
  const plan3 = await configureAdguard(params(drift, { mode: 'plan' }));
  await assert.rejects(() => configureAdguard(params(drift, {
    planReceipt: plan3.receipt, sourceSha: '3'.repeat(40)
  })), /source SHA changed/);
  await assert.rejects(() => configureAdguard(params(drift, {
    planReceipt: plan3.receipt, gitopsRevision: '4'.repeat(40)
  })), /GitOps revision changed/);
});

test('partial provider failure is observable per site and never rolls back successful writes', async () => {
  const fake = fakeAdguard({ failAddFor: 'staging-ui-nession.bestnathan.top' });
  const plan = await configureAdguard(params(fake, { mode: 'plan' }));
  let captured = null;
  await assert.rejects(() => configureAdguard(params(fake, {
    planReceipt: plan.receipt
  })), error => {
    captured = error;
    return /partially failed/.test(error.message);
  });
  assert.ok(captured.results.length, expectedPlan.length);
  const failed = captured.results.filter(entry => entry.status === 'failed');
  assert.deepEqual(failed.map(entry => entry.domain), ['staging-ui-nession.bestnathan.top']);
  assert.ok(captured.results.filter(entry => entry.status === 'ok').length > 0);
  assert.ok(captured.receipt, 'partial failure still emits a sanitized receipt');
  // Successful independent changes remain in place.
  assert.ok(fake.state.rewrites.some(r => r.domain === 'staging-nession.bestnathan.top'));
  assert.ok(!fake.state.rewrites.some(r => r.domain === 'staging-ui-nession.bestnathan.top'));
  assert.equal(JSON.stringify(captured.receipt).includes(password), false);
});

test('credential and preflight failures are sanitized and block writes', async () => {
  const badAuth = fakeAdguard({ badAuth: true });
  await assert.rejects(() => configureAdguard(params(badAuth)), /authentication rejected/);
  assert.ok(badAuth.state.requests.every(req => req.method === 'GET'));

  const stopped = fakeAdguard({ running: false });
  await assert.rejects(() => configureAdguard(params(stopped)), /not a running AdGuard Home/);

  const broken = fakeAdguard({ failStatus: 500 });
  await assert.rejects(() => configureAdguard(params(broken)), /HTTP 500/);

  const output = [];
  const fake = fakeAdguard();
  await configureAdguard(params(fake, { mode: 'plan', logger: line => output.push(line) }));
  assert.equal(output.join('').includes(password), false);
  assert.equal(output.join('').includes(apiUrl), false);
});

test('LAN deletion requires explicit approval, exact current state and readback', async () => {
  const scope = { fqdn: 'staging-nession.bestnathan.top', answerRef: 'LAN_GATEWAY_IP' };
  const deleteApproval = approval('staging-server', 'delete', scope);
  const fake = fakeAdguard({ rewrites: [{ domain: scope.fqdn, answer: gateway }] });
  const plan = await configureAdguard(params(fake, {
    mode: 'plan-delete', siteSelection: 'staging-server', approvals: deleteApproval
  }));
  assert.equal(plan.kind, 'delete');
  const result = await configureAdguard(params(fake, {
    mode: 'delete', siteSelection: 'staging-server',
    planReceipt: plan.receipt, approvals: deleteApproval
  }));
  assert.deepEqual(result, { kind: 'delete', verified: true });
  assert.equal(fake.state.rewrites.length, 0);

  const unapproved = fakeAdguard({ rewrites: [{ domain: scope.fqdn, answer: gateway }] });
  await assert.rejects(() => configureAdguard(params(unapproved, {
    mode: 'delete', siteSelection: 'staging-server'
  })), /reviewed explicit approval/);

  const wrongAnswer = fakeAdguard({ rewrites: [{ domain: scope.fqdn, answer: '192.168.2.99' }] });
  await assert.rejects(() => configureAdguard(params(wrongAnswer, {
    mode: 'delete', siteSelection: 'staging-server', approvals: deleteApproval
  })), /differs from the reviewed removal scope/);

  await assert.rejects(() => configureAdguard(params(fake, {
    mode: 'delete', siteSelection: 'all', approvals: deleteApproval
  })), /never a bulk selection/);

  const stale = fakeAdguard({ rewrites: [{ domain: scope.fqdn, answer: gateway }] });
  const plan2 = await configureAdguard(params(stale, {
    mode: 'plan-delete', siteSelection: 'staging-server', approvals: deleteApproval
  }));
  stale.state.rewrites.push({ domain: 'unrelated.nhome.local', answer: '192.168.2.99' });
  await assert.rejects(() => configureAdguard(params(stale, {
    mode: 'delete', siteSelection: 'staging-server',
    planReceipt: plan2.receipt, approvals: deleteApproval
  })), /provider state changed since plan/);
});

test('site selection is bounded to reviewed enabled sites', async () => {
  const fake = fakeAdguard();
  await assert.rejects(() => configureAdguard(params(fake, { siteSelection: 'ghost' })),
    /Unregistered or disabled/);
  await assert.rejects(() => configureAdguard(params(fake, { siteSelection: 'production-mcp' })),
    /Unregistered or disabled/);
  const single = await configureAdguard(params(fake, { mode: 'plan', siteSelection: 'staging-server' }));
  assert.deepEqual(single.operations.map(op => op.domain), ['staging-nession.bestnathan.top']);
});

test('LAN resolver probes require exact A answer and no public IPv6 fallback', async () => {
  const entry = { domain: 'staging-nession.bestnathan.top', answer: gateway };
  const good = {
    resolve4: async () => [gateway],
    resolve6: async () => { const e = new Error('no data'); e.code = 'ENODATA'; throw e; }
  };
  const probes = await lanProbes({ expected: [entry], gatewayIp: gateway, resolver: good });
  assert.equal(probes[0].status, 'ok');
  const wrongA = {
    resolve4: async () => ['192.168.2.99'],
    resolve6: async () => { const e = new Error('no data'); e.code = 'ENODATA'; throw e; }
  };
  assert.equal((await lanProbes({ expected: [entry], gatewayIp: gateway, resolver: wrongA }))[0].status, 'failed');
  const publicV6 = {
    resolve4: async () => [gateway],
    resolve6: async () => ['2001:db8::1']
  };
  assert.equal((await lanProbes({ expected: [entry], gatewayIp: gateway, resolver: publicV6 }))[0].status, 'failed');
  const unreachable = {
    resolve4: async () => { const e = new Error('refused'); e.code = 'ECONNREFUSED'; throw e; },
    resolve6: async () => { const e = new Error('refused'); e.code = 'ECONNREFUSED'; throw e; }
  };
  assert.equal((await lanProbes({ expected: [entry], gatewayIp: gateway, resolver: unreachable }))[0].status, 'failed');
  await assert.rejects(() => lanProbes({ expected: [entry], gatewayIp: gateway, resolver: null }),
    /validated DNS_RESOLVER/);
});

test('apply only registers canonical-ready sites and reports migration pending', async () => {
  const fake = fakeAdguard();
  const plan = await configureAdguard(params(fake, { mode: 'plan' }));
  const result = await configureAdguard(params(fake, {
    mode: 'apply', planReceipt: plan.receipt, readySites: ['staging-mcp']
  }));
  assert.deepEqual(result.results.map(entry => entry.domain), ['staging-mcp-nession.bestnathan.top']);
  assert.ok(result.pendingMigration.includes('staging-server'));
  assert.equal(result.pendingMigration.length, expectedPlan.length - 1);
  assert.equal(fake.state.rewrites.length, 1);
  await assert.rejects(() => configureAdguard(params(fake, {
    mode: 'apply', planReceipt: plan.receipt, readySites: 'staging-mcp'
  })), /array of reviewed site IDs/);
});

test('pure plan classification covers create/noop/update/blocked deterministically', () => {
  const expected = [{ site: 's', domain: 'x.bestnathan.top', answer: gateway, answerRef: 'LAN_GATEWAY_IP' }];
  assert.equal(planRewrites(expected, [])[0].kind, 'create');
  assert.equal(planRewrites(expected, [{ domain: 'x.bestnathan.top', answer: gateway }])[0].kind, 'noop');
  assert.equal(planRewrites(expected, [{ domain: 'x.bestnathan.top', answer: '192.168.2.99' }])[0].kind, 'blocked');
  assert.equal(planRewrites(expected, [{ domain: 'x.bestnathan.top', answer: '192.168.2.99' }],
    { approvedGatewayChanges: new Set(['x.bestnathan.top']) })[0].kind, 'update');
});

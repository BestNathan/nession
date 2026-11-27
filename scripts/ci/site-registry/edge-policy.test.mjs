#!/usr/bin/env node
// Public-edge policy fixture tests (#4589 SC-03): exact approved MCP /mcp
// allowlist, private/unknown Host/SNI denial, forced-Host direct-IP denial,
// spoofed forwarding rejection, no wildcard or private-route fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEdgePolicy, evaluateEdgeRequest, loadFixturePolicy } from './edge-policy.mjs';
import { loadRegistry } from './site-registry.mjs';

const loaded = loadRegistry();
const policy = renderEdgePolicy();
const cfCidrs = ['104.16.0.0/13', '172.64.0.0/13'];
const cfSource = '104.21.15.20';

function request(extra = {}) {
  return {
    host: 'staging-mcp-nession.bestnathan.top',
    sni: 'staging-mcp-nession.bestnathan.top',
    path: '/mcp',
    sourceIp: cfSource,
    ...extra
  };
}

test('rendered policy matches the checked-in fixture and the reviewed allowlist', () => {
  assert.deepEqual(policy, loadFixturePolicy());
  assert.deepEqual(policy.public.map(entry => entry.host), ['staging-mcp-nession.bestnathan.top']);
  assert.equal(policy.public[0].path, '/mcp');
  assert.equal(policy.public[0].pathType, 'Exact');
  assert.equal(policy.public[0].originTls, 'full-strict');
  assert.equal(policy.public[0].authentication, 'required');
  assert.deepEqual(policy.public[0].backend, { service: 'nession-mcp-staging', port: 9090 });
  for (const host of policy.privateHosts) {
    assert.ok(!host.endsWith('.nhome.local'), 'nhome.local is out of scope');
    assert.ok(!policy.public.some(entry => entry.host === host));
  }
  assert.ok(policy.privateHosts.includes('staging-nession.bestnathan.top'));
  assert.ok(policy.privateHosts.includes('staging.nession.bestnathan.top'));
  assert.ok(policy.privateHosts.includes('nession.bestnathan.top'));
  const activated = structuredClone(loaded.registry);
  activated.sites.find(site => site.id === 'production-mcp').enabled = true;
  const next = renderEdgePolicy(activated);
  assert.deepEqual(next.public.map(entry => entry.host),
    ['mcp-nession.bestnathan.top', 'staging-mcp-nession.bestnathan.top']);
});

test('approved MCP request passes with exact host, SNI, path and Cloudflare source', () => {
  const result = evaluateEdgeRequest(policy, request(), { cloudflareCidrs: cfCidrs });
  assert.equal(result.decision, 'allow');
  assert.deepEqual(result.backend, { service: 'nession-mcp-staging', port: 9090 });
  const queryToken = evaluateEdgeRequest(policy, request({ path: '/mcp?token=x' }), { cloudflareCidrs: cfCidrs });
  assert.equal(queryToken.decision, 'allow');
  const upper = evaluateEdgeRequest(policy, request({
    host: 'STAGING-MCP-NESSION.BESTNATHAN.TOP', sni: 'STAGING-MCP-NESSION.BESTNATHAN.TOP'
  }), { cloudflareCidrs: cfCidrs });
  assert.equal(upper.decision, 'allow');
  const forwarded = evaluateEdgeRequest(policy, request({
    forwardedHost: 'staging-mcp-nession.bestnathan.top', forwardedProto: 'https', forwardedFor: '203.0.113.9'
  }), { cloudflareCidrs: cfCidrs });
  assert.equal(forwarded.decision, 'allow');
});

test('private and unknown Nession hosts are denied with no private-route fallback', () => {
  for (const host of [
    'staging-nession.bestnathan.top', 'staging.nession.bestnathan.top',
    'nession.bestnathan.top', 'agent-nession.bestnathan.top',
    'ui.nession.bestnathan.top', 'preprod-agent-nession.bestnathan.top',
    'mcp-nession.bestnathan.top', 'evil.bestnathan.top', 'nession.example.com'
  ]) {
    const result = evaluateEdgeRequest(policy, request({ host, sni: host }), { cloudflareCidrs: cfCidrs });
    assert.equal(result.decision, 'deny', host);
    assert.ok(['private-host', 'unknown-host'].includes(result.reason), host);
    assert.equal(result.backend, undefined, 'no backend may be selected for a denied host');
  }
  assert.equal(evaluateEdgeRequest(policy, request({ host: '' }), { cloudflareCidrs: cfCidrs }).reason, 'unknown-host');
  assert.equal(evaluateEdgeRequest(policy, null, { cloudflareCidrs: cfCidrs }).reason, 'unknown-host');
  assert.equal(evaluateEdgeRequest(policy, request({ host: '*.bestnathan.top' }), { cloudflareCidrs: cfCidrs }).reason, 'wildcard-host');
});

test('forced Host on direct origin IP and SNI mismatch are denied', () => {
  const forced = evaluateEdgeRequest(policy, request({
    sni: '', sourceIp: '192.168.2.10'
  }), { cloudflareCidrs: cfCidrs });
  assert.equal(forced.decision, 'deny');
  const mismatch = evaluateEdgeRequest(policy, request({
    sni: 'other.bestnathan.top'
  }), { cloudflareCidrs: cfCidrs });
  assert.equal(mismatch.reason, 'sni-mismatch');
  const missing = evaluateEdgeRequest(policy, request({ sni: undefined }), { cloudflareCidrs: cfCidrs });
  assert.equal(missing.reason, 'sni-mismatch');
});

test('only the exact /mcp path passes; alternate paths never fall back', () => {
  for (const path of ['/', '/mcp/', '/mcp/extra', '/mcpX', '/admin', '/mcp?x=1&y=2/../']) {
    const result = evaluateEdgeRequest(policy, request({ path }), { cloudflareCidrs: cfCidrs });
    if (path === '/mcp?x=1&y=2/../') {
      assert.equal(result.decision, 'allow', 'query string is not part of the exact path');
    } else {
      assert.equal(result.reason, 'non-exact-path', path);
    }
  }
});

test('non-Cloudflare direct-origin sources and spoofed forwarding identity are denied', () => {
  const direct = evaluateEdgeRequest(policy, request({ sourceIp: '203.0.113.9' }), { cloudflareCidrs: cfCidrs });
  assert.equal(direct.reason, 'non-cloudflare-source');
  const noCidrs = evaluateEdgeRequest(policy, request(), { cloudflareCidrs: [] });
  assert.equal(noCidrs.reason, 'non-cloudflare-source');
  const spoofedHost = evaluateEdgeRequest(policy, request({
    forwardedHost: 'staging-nession.bestnathan.top'
  }), { cloudflareCidrs: cfCidrs });
  assert.equal(spoofedHost.reason, 'spoofed-forwarding');
  const httpProto = evaluateEdgeRequest(policy, request({ forwardedProto: 'http' }), { cloudflareCidrs: cfCidrs });
  assert.equal(httpProto.reason, 'spoofed-forwarding');
  const emptyFor = evaluateEdgeRequest(policy, request({ forwardedFor: '' }), { cloudflareCidrs: cfCidrs });
  assert.equal(emptyFor.reason, 'spoofed-forwarding');
});

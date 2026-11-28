#!/usr/bin/env node
// Origin CA retirement gate tests (#4589 SC-04): removal is gated on recorded
// #4588 cutover readiness and zero remaining consumers; public DNS and generic
// sealing survive; rollback/retirement never republishes private sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanConsumers, validateReadiness, evaluateRetirement,
  checkSourceInvariant, retirementPlan, CONSUMER_IDENTIFIERS
} from './retire-origin-ca.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const recorded = {
  status: 'recorded',
  cutoverVerified: true,
  issue: 4588,
  gitopsRevision: '2'.repeat(40),
  approvedBy: 'operator',
  verifiedAt: '2026-11-27',
  edgeTlsReadback: { runId: '123456789', workflow: 'Deploy / Staging Rollout Readback' }
};
const pending = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'scripts/ci/site-registry/origin-ca-cutover-readiness.json'), 'utf8'));

// Minimal independently attested cross-repository receipt (#4719 SC-02).
function validReceipt() {
  return {
    version: 1,
    kind: 'parallel-gateway-cutover-receipt',
    issue: 4719,
    status: 'attested',
    revisions: {
      nession: 'a'.repeat(40), nsible: 'b'.repeat(40),
      nitops: 'c'.repeat(40), gitops: recorded.gitopsRevision
    },
    path: {
      public: {
        verified: true, hops: ['cloudflare', 'hk', 'wireguard-gost', 'higress', 'service'],
        higressProtocol: 'http', higressTls: false, hkToSlb: false,
        sourceEnforced: 'cloudflare-ipv4-cidrs'
      },
      private: {
        verified: true, hops: ['adguard', 'slb', 'higress', 'service'],
        higressProtocol: 'http', higressTls: false, slbTls: true
      }
    },
    tls: {
      hk: {
        owner: 'nitops', san: ['staging-mcp-nession.bestnathan.top'],
        serial: '01AB', notAfter: '2027-02-26T00:00:00Z', chainVerified: true,
        publiclyTrusted: true, keyDistinctFromSlb: true,
        readback: { workflow: 'Deploy / Staging Rollout Readback', runId: '123456789' }
      },
      slb: {
        owner: 'nitops', san: ['*.bestnathan.top'],
        serial: '02CD', notAfter: '2027-02-26T00:00:00Z', chainVerified: true,
        publiclyTrusted: true,
        readback: { workflow: 'Deploy / Staging Rollout Readback', runId: '123456790' }
      }
    },
    protocol: {
      positive: ['mcp-initialize', 'mcp-tools-list', 'wss-101-frames', 'sse-beyond-60s'],
      negative: ['unauthorized-source', 'forged-forwarding', 'unknown-host',
        'private-host', 'sni-mismatch', 'alternate-path'],
      evidence: { independent: true, workflow: 'Acceptance / Cases', runId: '987654321' }
    },
    noRemainingConsumer: true,
    noQueryCredentialsInLogs: true,
    approvedBy: 'operator',
    verifiedAt: '2026-11-28'
  };
}

test('current source keeps the mechanism and blocks retirement until readiness', () => {
  const workflowText = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-configure-site.yml'), 'utf8');
  const invariant = checkSourceInvariant({
    workflowText,
    originCaScriptPresent: fs.existsSync(path.join(ROOT, 'scripts/ci/issue-cloudflare-origin-ca.mjs')),
    readiness: pending
  });
  assert.equal(invariant.ok, true);
  assert.equal(invariant.state, 'mechanism-present');
  const consumers = scanConsumers({
    '.github/workflows/deploy-configure-site.yml': workflowText,
    'scripts/ci/issue-cloudflare-origin-ca.mjs': fs.readFileSync(
      path.join(ROOT, 'scripts/ci/issue-cloudflare-origin-ca.mjs'), 'utf8'),
    'scripts/ci/seal-gitops-secret.mjs': fs.readFileSync(
      path.join(ROOT, 'scripts/ci/seal-gitops-secret.mjs'), 'utf8')
  });
  assert.ok(consumers.length > 0);
  const verdict = evaluateRetirement({ readiness: recorded, consumers });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'consumers-remain');
  assert.equal(retirementPlan(verdict).permitted, false);
});

test('removal without recorded cutover readiness fails the source invariant', () => {
  const result = checkSourceInvariant({
    workflowText: 'name: Deploy / Configure Site\non: workflow_dispatch\n',
    originCaScriptPresent: false,
    readiness: pending
  });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'retirement-without-recorded-readiness');
  assert.equal(checkSourceInvariant({
    workflowText: '', originCaScriptPresent: false, readiness: null
  }).ok, false);
});

test('recorded readiness plus an attested receipt and zero consumers permits a DNS-free retirement', () => {
  const receipt = validReceipt();
  const invariant = checkSourceInvariant({
    workflowText: 'name: Deploy / Configure Site\n',
    originCaScriptPresent: false,
    readiness: recorded,
    crossRepoReceipt: receipt
  });
  assert.equal(invariant.ok, true);
  assert.equal(invariant.state, 'retirement-readiness-recorded');
  const verdict = evaluateRetirement({ readiness: recorded, consumers: [], crossRepoReceipt: receipt });
  assert.equal(verdict.allowed, true);
  const plan = retirementPlan(verdict);
  assert.equal(plan.permitted, true);
  assert.deepEqual(plan.dnsOperations, []);
  assert.equal(plan.privateHostRepublished, false);
  assert.equal(plan.publicDnsPreserved, true);
  assert.equal(plan.genericSealedSecretPreserved, true);
  assert.ok(plan.removals.some(entry => entry.includes('issue-tls')));
  assert.ok(plan.gitopsOwnedBy4588.includes('environments/staging/mcp/sealed-tls.json'));
});

test('premature retirement is blocked without a valid cross-repo receipt', () => {
  const removed = {
    workflowText: 'name: Deploy / Configure Site\n',
    originCaScriptPresent: false,
    readiness: recorded,
    crossRepoReceipt: null
  };
  const missingSource = checkSourceInvariant(removed);
  assert.equal(missingSource.ok, false);
  assert.equal(missingSource.state, 'retirement-without-cross-repo-receipt');

  const missing = evaluateRetirement({
    readiness: recorded, consumers: [], crossRepoReceipt: null
  });
  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, 'cross-repo-receipt-invalid');

  const stale = evaluateRetirement({
    readiness: recorded, consumers: [], crossRepoReceipt: validReceipt(),
    expectedRevisions: { nsible: 'd'.repeat(40) }
  });
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason, 'cross-repo-receipt-stale');

  const readinessMismatch = evaluateRetirement({
    readiness: { ...recorded, gitopsRevision: 'e'.repeat(40) },
    consumers: [], crossRepoReceipt: validReceipt()
  });
  assert.equal(readinessMismatch.allowed, false);
  assert.equal(readinessMismatch.reason, 'cross-repo-receipt-stale');

  const stillConsumed = validReceipt();
  stillConsumed.noRemainingConsumer = false;
  const consumed = evaluateRetirement({
    readiness: recorded, consumers: [], crossRepoReceipt: stillConsumed
  });
  assert.equal(consumed.allowed, false);
  assert.equal(consumed.reason, 'cross-repo-receipt-invalid');

  const staleSource = checkSourceInvariant({
    ...removed,
    crossRepoReceipt: validReceipt(),
    readiness: { ...recorded, gitopsRevision: 'f'.repeat(40) }
  });
  assert.equal(staleSource.ok, false);
  assert.equal(staleSource.state, 'retirement-cross-repo-receipt-stale');
});

test('remaining GitOps TLS consumers block retirement even with readiness', () => {
  const consumers = scanConsumers({
    'environments/staging/mcp/kustomization.yaml': 'resources:\n- sealed-tls.json\n',
    'environments/staging/mcp/ingress.yaml': 'secretName: nession-mcp-staging-tls\n'
  });
  assert.ok(consumers.some(entry => entry.identifier === 'sealed-tls.json'));
  assert.ok(consumers.some(entry => entry.identifier === 'nession-mcp-staging-tls'));
  const verdict = evaluateRetirement({ readiness: recorded, consumers });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'consumers-remain');
});

test('readiness record requires exact cutover evidence fields', () => {
  assert.equal(validateReadiness(recorded), true);
  assert.equal(validateReadiness(pending), false);
  assert.equal(validateReadiness(null), false);
  const mutations = [
    entry => { entry.cutoverVerified = false; },
    entry => { entry.issue = 4589; },
    entry => { entry.gitopsRevision = 'short'; },
    entry => { delete entry.approvedBy; },
    entry => { entry.verifiedAt = '2026-13-99'; },
    entry => { entry.edgeTlsReadback = { runId: '0', workflow: 'x' }; },
    entry => { entry.edgeTlsReadback = { runId: '123', workflow: '' }; },
    entry => { delete entry.edgeTlsReadback; }
  ];
  for (const mutate of mutations) {
    const entry = structuredClone(recorded);
    mutate(entry);
    assert.equal(validateReadiness(entry), false);
  }
});

test('consumer scan detects every identifier and excludes the gate and docs', () => {
  for (const identifier of CONSUMER_IDENTIFIERS) {
    const consumers = scanConsumers({ 'scripts/ci/some-owner.mjs': 'uses ' + identifier + ' here' });
    assert.deepEqual(consumers, [{ file: 'scripts/ci/some-owner.mjs', identifier }]);
  }
  assert.deepEqual(scanConsumers({
    'scripts/ci/site-registry/retire-origin-ca.mjs': CONSUMER_IDENTIFIERS.join(' '),
    'scripts/ci/site-registry/retire-origin-ca.test.mjs': CONSUMER_IDENTIFIERS.join(' '),
    'docs/engineering/cloudflare-site-provisioning.md': CONSUMER_IDENTIFIERS.join(' ')
  }), []);
  assert.deepEqual(scanConsumers({
    'scripts/ci/seal-gitops-secret.mjs': 'generic sealing for NERSION_MCP_INBOUND_TOKEN only'
  }), []);
});

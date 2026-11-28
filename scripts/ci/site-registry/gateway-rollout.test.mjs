#!/usr/bin/env node
// Cross-repository cutover receipt tests (#4719 SC-02). The positive fixture
// proves the exact cross-repo revision/path/TLS/protocol contract; negative
// fixtures reject missing, stale and mismatched receipts plus premature Origin
// CA retirement.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_NEGATIVE, PROTOCOL_POSITIVE, RECEIPT_ISSUE, RECEIPT_KIND,
  RECEIPT_RELATIVE_PATH, REQUIRED_PUBLIC_HOPS, REQUIRED_PRIVATE_HOPS,
  REQUIRED_REVISIONS, validateCrossRepoReceipt, verifyCrossRepoReceipt
} from './gateway-rollout.mjs';
import {
  checkSourceInvariant, evaluateRetirement
} from './retire-origin-ca.mjs';

const readiness = {
  status: 'recorded',
  cutoverVerified: true,
  issue: 4588,
  gitopsRevision: '9'.repeat(40),
  approvedBy: 'operator',
  verifiedAt: '2026-11-28',
  edgeTlsReadback: { runId: '123456789', workflow: 'Deploy / Staging Rollout Readback' }
};

function revision(seed) {
  return String(seed).repeat(40).slice(0, 40);
}

function validReceipt() {
  return {
    version: 1,
    kind: RECEIPT_KIND,
    issue: RECEIPT_ISSUE,
    status: 'attested',
    revisions: {
      nession: revision('a'),
      nsible: revision('b'),
      nitops: revision('c'),
      gitops: readiness.gitopsRevision
    },
    path: {
      public: {
        verified: true,
        hops: [...REQUIRED_PUBLIC_HOPS],
        higressProtocol: 'http',
        higressTls: false,
        hkToSlb: false,
        sourceEnforced: 'cloudflare-ipv4-cidrs'
      },
      private: {
        verified: true,
        hops: [...REQUIRED_PRIVATE_HOPS],
        higressProtocol: 'http',
        higressTls: false,
        slbTls: true
      }
    },
    tls: {
      hk: {
        owner: 'nitops',
        san: ['staging-mcp-nession.bestnathan.top'],
        serial: '01AB',
        notAfter: '2027-02-26T00:00:00Z',
        chainVerified: true,
        publiclyTrusted: true,
        keyDistinctFromSlb: true,
        readback: { workflow: 'Deploy / Staging Rollout Readback', runId: '123456789' }
      },
      slb: {
        owner: 'nitops',
        san: ['*.bestnathan.top'],
        serial: '02CD',
        notAfter: '2027-02-26T00:00:00Z',
        chainVerified: true,
        publiclyTrusted: true,
        readback: { workflow: 'Deploy / Staging Rollout Readback', runId: '123456790' }
      }
    },
    protocol: {
      positive: [...PROTOCOL_POSITIVE],
      negative: [...PROTOCOL_NEGATIVE],
      evidence: { independent: true, workflow: 'Acceptance / Cases', runId: '987654321' }
    },
    noRemainingConsumer: true,
    noQueryCredentialsInLogs: true,
    approvedBy: 'operator',
    verifiedAt: '2026-11-28'
  };
}

function clone(value) {
  return structuredClone(value);
}

test('valid cross-repo receipt pins revisions, path, TLS and protocol evidence', () => {
  const receipt = validReceipt();
  assert.deepEqual(validateCrossRepoReceipt(receipt), []);
  assert.equal(verifyCrossRepoReceipt(receipt, { readiness }), true);
  assert.equal(verifyCrossRepoReceipt(receipt, {
    expectedRevisions: receipt.revisions
  }), true);
  assert.equal(RECEIPT_RELATIVE_PATH,
    'docs/engineering/receipts/4719-parallel-cutover-readback.json');
  for (const key of REQUIRED_REVISIONS) assert.equal(receipt.revisions[key].length, 40);
});

test('receipt validation rejects missing identity and exact-revision fields', () => {
  assert.deepEqual(validateCrossRepoReceipt(null), ['receipt is not an object']);
  const mutations = [
    ['receipt.kind', receipt => { receipt.kind = 'other'; }],
    ['receipt.version', receipt => { receipt.version = 2; }],
    ['receipt.issue', receipt => { receipt.issue = 4589; }],
    ['receipt.status', receipt => { receipt.status = 'pending'; }],
    ['revisions.nession', receipt => { delete receipt.revisions.nession; }],
    ['revisions.nsible', receipt => { receipt.revisions.nsible = 'short'; }],
    ['revisions.nitops', receipt => { receipt.revisions.nitops = 'C'.repeat(40); }],
    ['revisions.gitops', receipt => { receipt.revisions.gitops = ''; }]
  ];
  for (const [invariant, mutate] of mutations) {
    const receipt = validReceipt();
    mutate(receipt);
    const errors = validateCrossRepoReceipt(receipt);
    assert.ok(errors.some(error => error.includes(invariant)), invariant + ': ' + errors.join('; '));
  }
});

test('receipt validation rejects HK->SLB chaining, Higress TLS and public bypass', () => {
  const mutations = [
    ['path.public.verified', receipt => { receipt.path.public.verified = false; }],
    ['path.public.hops', receipt => {
      receipt.path.public.hops = ['cloudflare', 'hk', 'slb', 'higress', 'service'];
    }],
    ['path.public.hops', receipt => {
      receipt.path.public.hops = ['cloudflare', 'hk', 'higress', 'service'];
    }],
    ['path.public.higressProtocol', receipt => {
      receipt.path.public.higressProtocol = 'https';
    }],
    ['path.public.higressTls', receipt => { receipt.path.public.higressTls = true; }],
    ['path.public.hkToSlb', receipt => { receipt.path.public.hkToSlb = true; }],
    ['path.public.sourceEnforced', receipt => {
      receipt.path.public.sourceEnforced = 'client-header';
    }],
    ['path.private.verified', receipt => { receipt.path.private.verified = false; }],
    ['path.private.hops', receipt => {
      receipt.path.private.hops = ['cloudflare', 'adguard', 'slb', 'higress', 'service'];
    }],
    ['path.private.higressTls', receipt => { receipt.path.private.higressTls = true; }],
    ['path.private.slbTls', receipt => { receipt.path.private.slbTls = false; }]
  ];
  for (const [invariant, mutate] of mutations) {
    const receipt = validReceipt();
    mutate(receipt);
    assert.ok(validateCrossRepoReceipt(receipt).some(error => error.includes(invariant)),
      invariant);
  }
});

test('receipt validation rejects competing certificates, missing trust and weak evidence', () => {
  const mutations = [
    ['tls.hk.owner', receipt => { receipt.tls.hk.owner = 'nession'; }],
    ['tls.hk.san', receipt => { receipt.tls.hk.san = ['not-the-zone.example.com']; }],
    ['tls.hk.serial', receipt => { receipt.tls.hk.serial = ''; }],
    ['tls.hk.chainVerified', receipt => { receipt.tls.hk.chainVerified = false; }],
    ['tls.hk.publiclyTrusted', receipt => { receipt.tls.hk.publiclyTrusted = false; }],
    ['tls.hk.keyDistinctFromSlb', receipt => { receipt.tls.hk.keyDistinctFromSlb = false; }],
    ['tls.hk.readback', receipt => { delete receipt.tls.hk.readback; }],
    ['tls.slb.owner', receipt => { receipt.tls.slb.owner = 'operator'; }],
    ['tls.slb.san', receipt => { receipt.tls.slb.san = ['staging-nession.bestnathan.top']; }],
    ['Nession must not own', receipt => { receipt.tls.certificateOwner = 'nession'; }],
    ['protocol.positive', receipt => { receipt.protocol.positive.pop(); }],
    ['protocol.negative', receipt => { receipt.protocol.negative = ['unknown-host']; }],
    ['protocol.evidence.independent', receipt => { receipt.protocol.evidence.independent = false; }],
    ['protocol.evidence.workflow', receipt => { receipt.protocol.evidence.workflow = ''; }],
    ['protocol.evidence.runId', receipt => { receipt.protocol.evidence.runId = '0'; }],
    ['noRemainingConsumer', receipt => { receipt.noRemainingConsumer = false; }],
    ['noQueryCredentialsInLogs', receipt => { receipt.noQueryCredentialsInLogs = false; }],
    ['approvedBy', receipt => { receipt.approvedBy = ''; }],
    ['verifiedAt', receipt => { receipt.verifiedAt = '2026-13-99'; }]
  ];
  for (const [invariant, mutate] of mutations) {
    const receipt = validReceipt();
    mutate(receipt);
    assert.ok(validateCrossRepoReceipt(receipt).some(error => error.includes(invariant)),
      invariant);
  }
  const keyMaterial = validReceipt();
  keyMaterial.note = '-----BEGIN PRIVATE KEY-----';
  assert.ok(validateCrossRepoReceipt(keyMaterial).some(error => error.includes('key material')));
});

test('stale or mismatched receipts cannot be verified against the reviewed state', () => {
  const receipt = validReceipt();
  assert.throws(() => verifyCrossRepoReceipt(null), /Cross-repo cutover receipt rejected/);
  assert.throws(() => verifyCrossRepoReceipt(receipt, {
    expectedRevisions: { ...receipt.revisions, nsible: revision('d') }
  }), /Stale or mismatched cross-repo revision: nsible/);
  assert.throws(() => verifyCrossRepoReceipt(receipt, {
    readiness: { ...readiness, gitopsRevision: revision('e') }
  }), /Stale or mismatched cross-repo revision: gitops/);
  assert.throws(() => verifyCrossRepoReceipt(receipt, {
    readiness: { ...readiness, sourceRevision: revision('f') }
  }), /Stale or mismatched cross-repo revision: nession/);
  assert.throws(() => verifyCrossRepoReceipt(receipt, {
    expectedRevisions: { nession: 'short' }
  }), /Expected cross-repo revision is not 40-hex/);
});

test('premature Origin CA retirement is rejected by source invariant and retirement verdict', () => {
  const removed = {
    workflowText: 'name: Deploy / Configure Site\n',
    originCaScriptPresent: false,
    readiness
  };
  assert.equal(checkSourceInvariant(removed).state, 'retirement-without-cross-repo-receipt');
  assert.equal(checkSourceInvariant({
    ...removed, crossRepoReceipt: validReceipt()
  }).ok, true);

  const verdict = evaluateRetirement({ readiness, consumers: [] });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'cross-repo-receipt-invalid');
  const valid = evaluateRetirement({ readiness, consumers: [], crossRepoReceipt: validReceipt() });
  assert.equal(valid.allowed, true);
  assert.equal(valid.reason, 'readiness-recorded-cross-repo-receipt-and-no-consumers');

  const stale = evaluateRetirement({
    readiness, consumers: [], crossRepoReceipt: validReceipt(),
    expectedRevisions: { nitops: revision('e') }
  });
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason, 'cross-repo-receipt-stale');

  const consumed = evaluateRetirement({
    readiness, consumers: [{ file: 'x', identifier: 'sealed-tls.json' }],
    crossRepoReceipt: validReceipt()
  });
  assert.equal(consumed.allowed, false);
  assert.equal(consumed.reason, 'consumers-remain');
});

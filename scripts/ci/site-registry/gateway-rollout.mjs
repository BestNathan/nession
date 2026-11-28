#!/usr/bin/env node
// Owner: #4719 SC-02 — cross-repository parallel-gateway cutover receipt.
//
// Retirement of the legacy direct-TLS path (and the Origin CA mechanism that
// still answers it) is a three-repository operation: Nession owns the reviewed
// site/route contract, nsible owns the HK public gateway, nitops owns the SLB
// private gateway and certificates. A rollout may be attested only by a
// sanitized receipt that:
//
//   - pins the exact reviewed Nession, nsible, nitops and GitOps revisions;
//   - records the independently attested actual path (public: CF -> HK ->
//     Higress HTTP -> Service, private: AdGuard -> SLB -> Higress HTTP ->
//     Service) with no HK->SLB chain and no Higress business TLS;
//   - records both certificate lifecycles (distinct HK public key, nitops
//     wildcard at SLB) with an authenticated readback Run;
//   - records positive and negative protocol evidence (MCP, WSS, SSE; denied
//     source/header/host/path) from an independent attestation;
//   - proves no remaining consumer and no query credentials in logs.
//
// The receipt never carries key material or provider secrets. `retire-origin-ca`
// consumes this validator; this module does not perform live probes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIPT_KIND = 'parallel-gateway-cutover-receipt';
export const RECEIPT_VERSION = 1;
export const RECEIPT_ISSUE = 4719;
export const RECEIPT_RELATIVE_PATH = 'docs/engineering/receipts/4719-parallel-cutover-readback.json';
export const REQUIRED_REVISIONS = Object.freeze(['nession', 'nsible', 'nitops', 'gitops']);
export const REQUIRED_PUBLIC_HOPS = Object.freeze(['cloudflare', 'hk', 'higress', 'service']);
export const REQUIRED_PRIVATE_HOPS = Object.freeze(['adguard', 'slb', 'higress', 'service']);
export const PROTOCOL_POSITIVE = Object.freeze([
  'mcp-initialize', 'mcp-tools-list', 'wss-101-frames', 'sse-beyond-60s'
]);
export const PROTOCOL_NEGATIVE = Object.freeze([
  'unauthorized-source', 'forged-forwarding', 'unknown-host',
  'private-host', 'sni-mismatch', 'alternate-path'
]);

const HEX40 = /^[0-9a-f]{40}$/;
const DATE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const RUN_ID = /^[1-9][0-9]*$/;

function sameSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((entry, index) => entry === right[index]);
}

function checkTls(errors, name, tls) {
  if (!tls || typeof tls !== 'object') {
    errors.push('tls.' + name + ' must record the certificate readback');
    return;
  }
  if (tls.owner !== 'nitops') {
    errors.push('tls.' + name + '.owner must be nitops (single certificate owner)');
  }
  if (!Array.isArray(tls.san) || tls.san.length === 0 ||
      tls.san.some(entry => typeof entry !== 'string' || !entry.endsWith('.bestnathan.top'))) {
    errors.push('tls.' + name + '.san must record reviewed bestnathan.top names');
  }
  if (typeof tls.serial !== 'string' || tls.serial.trim().length === 0) {
    errors.push('tls.' + name + '.serial must be recorded');
  }
  if (typeof tls.notAfter !== 'string' || tls.notAfter.trim().length === 0) {
    errors.push('tls.' + name + '.notAfter must be recorded');
  }
  if (tls.chainVerified !== true) errors.push('tls.' + name + '.chainVerified must be true');
  if (tls.publiclyTrusted !== true) errors.push('tls.' + name + '.publiclyTrusted must be true');
  const readback = tls.readback ?? {};
  if (typeof readback.workflow !== 'string' || readback.workflow.trim().length === 0) {
    errors.push('tls.' + name + '.readback.workflow must name the authenticated producer');
  }
  if (!RUN_ID.test(String(readback.runId ?? ''))) {
    errors.push('tls.' + name + '.readback.runId must be a positive Run ID');
  }
}

export function validateCrossRepoReceipt(receipt) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return ['receipt is not an object'];
  }
  if (receipt.kind !== RECEIPT_KIND) errors.push('receipt.kind must be ' + RECEIPT_KIND);
  if (receipt.version !== RECEIPT_VERSION) errors.push('receipt.version must be 1');
  if (receipt.issue !== RECEIPT_ISSUE) errors.push('receipt.issue must be 4719');
  if (receipt.status !== 'attested') errors.push('receipt.status must be attested');

  const revisions = receipt.revisions ?? {};
  for (const key of REQUIRED_REVISIONS) {
    if (!HEX40.test(String(revisions[key] ?? ''))) {
      errors.push('receipt.revisions.' + key + ' must be an exact 40-hex revision');
    }
  }

  const publicPath = receipt.path?.public ?? {};
  if (publicPath.verified !== true) errors.push('receipt.path.public.verified must be true');
  if (!sameSet(publicPath.hops, REQUIRED_PUBLIC_HOPS)) {
    errors.push('receipt.path.public.hops must be exactly ' + REQUIRED_PUBLIC_HOPS.join('->'));
  }
  if (publicPath.higressProtocol !== 'http') {
    errors.push('receipt.path.public.higressProtocol must be http');
  }
  if (publicPath.higressTls !== false) {
    errors.push('receipt.path.public.higressTls must be false');
  }
  if (publicPath.hkToSlb !== false) {
    errors.push('receipt.path.public.hkToSlb must be false (parallel gateways, no chaining)');
  }
  if (publicPath.sourceEnforced !== 'cloudflare-ipv4-cidrs') {
    errors.push('receipt.path.public.sourceEnforced must be cloudflare-ipv4-cidrs');
  }

  const privatePath = receipt.path?.private ?? {};
  if (privatePath.verified !== true) errors.push('receipt.path.private.verified must be true');
  if (!sameSet(privatePath.hops, REQUIRED_PRIVATE_HOPS)) {
    errors.push('receipt.path.private.hops must be exactly ' + REQUIRED_PRIVATE_HOPS.join('->'));
  }
  if (privatePath.higressProtocol !== 'http') {
    errors.push('receipt.path.private.higressProtocol must be http');
  }
  if (privatePath.higressTls !== false) {
    errors.push('receipt.path.private.higressTls must be false');
  }
  if (privatePath.slbTls !== true) errors.push('receipt.path.private.slbTls must be true');

  checkTls(errors, 'hk', receipt.tls?.hk);
  checkTls(errors, 'slb', receipt.tls?.slb);
  if (receipt.tls?.hk?.keyDistinctFromSlb !== true) {
    errors.push('tls.hk.keyDistinctFromSlb must be true');
  }
  if (!Array.isArray(receipt.tls?.slb?.san) || !receipt.tls.slb.san.includes('*.bestnathan.top')) {
    errors.push('tls.slb.san must include *.bestnathan.top');
  }
  if (receipt.tls?.nession || receipt.tls?.certificateOwner === 'nession') {
    errors.push('Nession must not own a certificate or issuer');
  }

  const protocol = receipt.protocol ?? {};
  if (!sameSet(protocol.positive, PROTOCOL_POSITIVE)) {
    errors.push('receipt.protocol.positive must record: ' + PROTOCOL_POSITIVE.join(', '));
  }
  if (!sameSet(protocol.negative, PROTOCOL_NEGATIVE)) {
    errors.push('receipt.protocol.negative must record: ' + PROTOCOL_NEGATIVE.join(', '));
  }
  const evidence = protocol.evidence ?? {};
  if (evidence.independent !== true) {
    errors.push('receipt.protocol.evidence.independent must be true');
  }
  if (typeof evidence.workflow !== 'string' || evidence.workflow.trim().length === 0) {
    errors.push('receipt.protocol.evidence.workflow must name the authenticated producer');
  }
  if (!RUN_ID.test(String(evidence.runId ?? ''))) {
    errors.push('receipt.protocol.evidence.runId must be a positive Run ID');
  }

  if (receipt.noRemainingConsumer !== true) {
    errors.push('receipt.noRemainingConsumer must be true');
  }
  if (receipt.noQueryCredentialsInLogs !== true) {
    errors.push('receipt.noQueryCredentialsInLogs must be true');
  }
  if (typeof receipt.approvedBy !== 'string' || receipt.approvedBy.trim().length === 0) {
    errors.push('receipt.approvedBy must be recorded');
  }
  if (!DATE.test(String(receipt.verifiedAt ?? ''))) {
    errors.push('receipt.verifiedAt must be an ISO date');
  }

  const serialized = JSON.stringify(receipt);
  if (/PRIVATE KEY/.test(serialized) || /"tls\.key"\s*:/.test(serialized) ||
      /"privateKey"\s*:/.test(serialized) || /"token"\s*:/.test(serialized)) {
    errors.push('receipt must not contain key material or credentials');
  }
  return errors;
}

// Exact revision binding. `expectedRevisions` is the reviewed cross-repo state
// being retired; `readiness` is the #4588 cutover readiness record. Either
// mismatch means the receipt describes a different rollout than the one under
// review, i.e. it is stale or belongs to another path.
export function verifyCrossRepoReceipt(receipt, { expectedRevisions = null, readiness = null } = {}) {
  const errors = validateCrossRepoReceipt(receipt);
  if (errors.length > 0) {
    throw new Error('Cross-repo cutover receipt rejected: ' + errors.join('; '));
  }
  if (expectedRevisions && typeof expectedRevisions === 'object') {
    for (const key of REQUIRED_REVISIONS) {
      const expected = expectedRevisions[key];
      if (expected === undefined || expected === null) continue;
      if (!HEX40.test(String(expected))) {
        throw new Error('Expected cross-repo revision is not 40-hex: ' + key);
      }
      if (receipt.revisions[key] !== expected) {
        throw new Error('Stale or mismatched cross-repo revision: ' + key);
      }
    }
  }
  if (readiness && typeof readiness === 'object') {
    if (typeof readiness.gitopsRevision === 'string' &&
        receipt.revisions.gitops !== readiness.gitopsRevision) {
      throw new Error('Stale or mismatched cross-repo revision: gitops');
    }
    if (typeof readiness.sourceRevision === 'string' &&
        receipt.revisions.nession !== readiness.sourceRevision) {
      throw new Error('Stale or mismatched cross-repo revision: nession');
    }
  }
  return true;
}

export function receiptPath(root) {
  return path.join(root, RECEIPT_RELATIVE_PATH);
}

export function moduleDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

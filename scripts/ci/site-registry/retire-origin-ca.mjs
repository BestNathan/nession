#!/usr/bin/env node
// Legacy Cloudflare Origin CA retirement gate (#4589 SC-04). Removal of the
// issue-tls workflow action and Origin CA implementation is permitted only
// after a recorded #4588 cutover/readback AND zero remaining consumers in
// source and GitOps. This issue owns workflow/script removal and docs; #4588
// owns the legacy GitOps TLS objects. Public DNS and the generic SealedSecret
// mechanism are preserved, and retirement never republishes private DNS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../../..');

export const CONSUMER_IDENTIFIERS = Object.freeze([
  'issue-cloudflare-origin-ca',
  'issue-tls',
  'MCP_TLS_PEM_BUNDLE',
  'sealed-tls.json',
  'nession-mcp-staging-tls',
  'client/v4/certificates',
  'origin-rsa'
]);

// The retirement gate itself and durable documentation are not consumers.
export const SCAN_ALLOWLIST = Object.freeze([
  'scripts/ci/site-registry/retire-origin-ca.mjs',
  'scripts/ci/site-registry/retire-origin-ca.test.mjs',
  'scripts/ci/site-registry/origin-ca-cutover-readiness.json'
]);

export function scanConsumers(files) {
  const consumers = [];
  for (const [file, content] of Object.entries(files)) {
    if (SCAN_ALLOWLIST.includes(file) || file.startsWith('docs/')) continue;
    if (typeof content !== 'string') continue;
    for (const identifier of CONSUMER_IDENTIFIERS) {
      if (content.includes(identifier)) {
        consumers.push({ file, identifier });
      }
    }
  }
  return consumers.sort((a, b) =>
    (a.file + a.identifier).localeCompare(b.file + b.identifier));
}

export function validateReadiness(record) {
  if (!record || typeof record !== 'object' || record.status !== 'recorded' ||
      record.cutoverVerified !== true || record.issue !== 4588 ||
      typeof record.gitopsRevision !== 'string' || !/^[0-9a-f]{40}$/.test(record.gitopsRevision) ||
      typeof record.approvedBy !== 'string' || record.approvedBy.length === 0 ||
      typeof record.verifiedAt !== 'string' ||
      !/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(record.verifiedAt) ||
      !record.edgeTlsReadback || typeof record.edgeTlsReadback.runId !== 'string' ||
      !/^[1-9][0-9]*$/.test(record.edgeTlsReadback.runId) ||
      typeof record.edgeTlsReadback.workflow !== 'string' ||
      record.edgeTlsReadback.workflow.length === 0) {
    return false;
  }
  return true;
}

export function evaluateRetirement({ readiness, consumers }) {
  if (Array.isArray(consumers) && consumers.length > 0) {
    return { allowed: false, reason: 'consumers-remain', consumers };
  }
  if (!validateReadiness(readiness)) {
    return { allowed: false, reason: 'cutover-readiness-not-recorded' };
  }
  return { allowed: true, reason: 'readiness-recorded-and-no-consumers' };
}

// Enforceable source invariant: if the Origin CA mechanism has been removed
// from the workflow/source, the recorded cutover readiness must exist. While
// the mechanism is still present, retirement simply has not happened yet.
export function checkSourceInvariant({ workflowText, originCaScriptPresent, readiness }) {
  const mechanismPresent = originCaScriptPresent ||
    (typeof workflowText === 'string' && workflowText.includes('issue-tls'));
  if (mechanismPresent) {
    return { ok: true, state: 'mechanism-present' };
  }
  if (!validateReadiness(readiness)) {
    return { ok: false, state: 'retirement-without-recorded-readiness' };
  }
  return { ok: true, state: 'retirement-readiness-recorded' };
}

// Retirement is a TLS-mechanism removal only: no DNS operation, no private
// host republication, public DNS and generic sealing preserved.
export function retirementPlan(verdict) {
  if (!verdict.allowed) {
    return { permitted: false, reason: verdict.reason };
  }
  return {
    permitted: true,
    removals: [
      '.github/workflows/deploy-configure-site.yml#issue-tls',
      'scripts/ci/issue-cloudflare-origin-ca.mjs',
      'scripts/ci/issue-cloudflare-origin-ca.test.mjs',
      'scripts/ci/seal-gitops-secret.mjs#MCP_TLS_PEM_BUNDLE-target'
    ],
    gitopsOwnedBy4588: ['environments/staging/mcp/sealed-tls.json'],
    dnsOperations: [],
    privateHostRepublished: false,
    publicDnsPreserved: true,
    genericSealedSecretPreserved: true
  };
}

function readOptional(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function cli() {
  const command = process.argv[2];
  const readiness = JSON.parse(readOptional(path.join(DIR, 'origin-ca-cutover-readiness.json')) ?? 'null');
  if (command === 'check-source') {
    const workflowText = readOptional(path.join(ROOT, '.github/workflows/deploy-configure-site.yml')) ?? '';
    const result = checkSourceInvariant({
      workflowText,
      originCaScriptPresent: fs.existsSync(path.join(ROOT, 'scripts/ci/issue-cloudflare-origin-ca.mjs')),
      readiness
    });
    console.log('ORIGIN_CA_RETIREMENT_SOURCE_V1 ' + JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'evaluate') {
    const gitopsDir = process.env.GITOPS_CHECKOUT;
    const files = {
      '.github/workflows/deploy-configure-site.yml':
        readOptional(path.join(ROOT, '.github/workflows/deploy-configure-site.yml')) ?? '',
      'scripts/ci/issue-cloudflare-origin-ca.mjs':
        readOptional(path.join(ROOT, 'scripts/ci/issue-cloudflare-origin-ca.mjs')) ?? '',
      'scripts/ci/seal-gitops-secret.mjs':
        readOptional(path.join(ROOT, 'scripts/ci/seal-gitops-secret.mjs')) ?? ''
    };
    if (gitopsDir) {
      for (const relative of [
        'environments/staging/mcp/kustomization.yaml',
        'environments/staging/mcp/ingress.yaml'
      ]) {
        const full = path.join(gitopsDir, relative);
        if (fs.existsSync(full)) files[relative] = fs.readFileSync(full, 'utf8');
      }
      if (fs.existsSync(path.join(gitopsDir, 'environments/staging/mcp/sealed-tls.json'))) {
        files['environments/staging/mcp/sealed-tls.json'] = 'sealed-tls.json';
      }
    }
    const consumers = scanConsumers(files);
    const verdict = evaluateRetirement({ readiness, consumers });
    console.log('ORIGIN_CA_RETIREMENT_V1 ' + JSON.stringify({ verdict, plan: retirementPlan(verdict) }));
    return;
  }
  throw new Error('usage: retire-origin-ca.mjs <check-source|evaluate>');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    cli();
  } catch (error) {
    console.error('Origin CA retirement gate failed: ' + error.message);
    process.exitCode = 1;
  }
}

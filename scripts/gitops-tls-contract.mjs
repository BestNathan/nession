#!/usr/bin/env node
// Owner: #4588 SC-03 — the GitOps certificate ownership / consumption contract.
//
// nitops (BestNathan/nitops#2) owns cert-manager, the DNS-01 ClusterIssuer and
// the single wildcard Certificate `*.bestnathan.top` in the serving `slb`
// namespace; the target Secret is owned exclusively by cert-manager and SLB
// nginx is the actual TLS terminator. Nession consumes that certificate through
// host/SAN coverage at SLB — it installs no cert-manager, issues no certificate,
// and writes no competing Certificate/Issuer/SealedSecret.
//
// This checker reads a GitOps checkout (or fixture tree) and proves:
//   - no competing issuer / Certificate / cert-manager installation in Nession;
//   - no duplicate writer for the cert-manager-owned Secret (nothing Nession
//     writes into the nitops-owned `slb` namespace, no raw private key material);
//   - the legacy staging MCP Origin CA TLS (sealed-tls.json + ingress
//     `nession-mcp-staging-tls`) is either intact (pre-cutover) or its retirement
//     / consumption switch is BLOCKED until a sanitized cutover readback receipt
//     is recorded;
//   - rollback to the legacy state is always allowed and never requires rolling
//     back cert-manager or deleting a shared Secret.
//
// It does not read a cluster or activate anything. Hostname/backend/dormancy is
// owned by scripts/gitops-host-contract.mjs (#4588 SC-01).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYamlDocuments } from './gitops-storage-contract.mjs';

const LEGACY_TLS_SECRET = 'nession-mcp-staging-tls';
const LEGACY_TLS_RESOURCE = 'environments/staging/mcp/sealed-tls.json';
const STAGING_MCP_INGRESS = 'environments/staging/mcp/ingress.yaml';
const NITOPS_NAMESPACE = 'slb';
const FORBIDDEN_KINDS = new Set([
  'Certificate', 'CertificateRequest', 'ClusterIssuer', 'Issuer',
]);
const DEFAULT_RECEIPT = 'docs/engineering/receipts/4588-tls-cutover-readback.json';

function fail(message) {
  throw new Error(message);
}

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function walkTree(root, relative, visit) {
  const dir = path.join(root, relative);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRelative = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      walkTree(root, childRelative, visit);
    } else if (entry.isFile()) {
      visit(childRelative, fs.readFileSync(path.join(root, childRelative), 'utf8'));
    }
  }
}

// ---------------------------------------------------------------------------
// Cutover readback receipt. Sanitized operational evidence recorded on trusted
// main; its presence is the readiness gate for retirement / consumption switch.
// ---------------------------------------------------------------------------
const HEX40 = /^[a-f0-9]{40}$/;

export function validateReceipt(receipt) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object') return ['receipt is not an object'];
  if (receipt.kind !== 'tls-cutover-readback') errors.push('receipt.kind must be tls-cutover-readback');
  if (receipt.issue !== 4588) errors.push('receipt.issue must be 4588');
  if (!HEX40.test(String(receipt.gitopsRevision ?? ''))) errors.push('receipt.gitopsRevision must be a 40-hex GitOps revision');
  if (!HEX40.test(String(receipt.sourceRevision ?? ''))) errors.push('receipt.sourceRevision must be a 40-hex source revision');
  if (!String(receipt.gatewayIdentity ?? '').trim()) errors.push('receipt.gatewayIdentity must name the actual TLS gateway');
  const cert = receipt.certificate ?? {};
  const san = Array.isArray(cert.san) ? cert.san.map(String) : [];
  if (!san.includes('*.bestnathan.top')) errors.push('receipt.certificate.san must cover *.bestnathan.top');
  if (!String(cert.serial ?? '').trim()) errors.push('receipt.certificate.serial must be recorded');
  if (!String(cert.notAfter ?? '').trim()) errors.push('receipt.certificate.notAfter must be recorded');
  if (cert.chainVerified !== true) errors.push('receipt.certificate.chainVerified must be true');
  if (cert.publiclyTrusted !== true) errors.push('receipt.certificate.publiclyTrusted must be true');
  if (receipt.noRemainingConsumer !== true) errors.push('receipt.noRemainingConsumer must be true');
  if (!String(receipt.verifiedAt ?? '').trim()) errors.push('receipt.verifiedAt must be recorded');
  // No key material may ever be recorded in a receipt.
  const serialized = JSON.stringify(receipt);
  if (/PRIVATE KEY/.test(serialized) || /"tls\.key"\s*:/.test(serialized) ||
      /"privateKey"\s*:/.test(serialized)) {
    errors.push('receipt must not contain private key material');
  }
  return errors;
}

function readReceipt(receiptPath) {
  if (!fs.existsSync(receiptPath)) return { present: false, receipt: null, errors: [] };
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    return { present: true, receipt: null, errors: ['receipt is not valid JSON: ' + error.message] };
  }
  return { present: true, receipt, errors: validateReceipt(receipt) };
}

// ---------------------------------------------------------------------------
// GitOps tree assertions.
// ---------------------------------------------------------------------------
function stagingTlsState(root) {
  const sealedPresent = fs.existsSync(path.join(root, LEGACY_TLS_RESOURCE));
  const ingressText = fs.existsSync(path.join(root, STAGING_MCP_INGRESS))
    ? fs.readFileSync(path.join(root, STAGING_MCP_INGRESS), 'utf8')
    : null;
  let secretName = null;
  let tlsBlockPresent = false;
  if (ingressText !== null) {
    const [ingress] = parseYamlDocuments(ingressText);
    const tls = ingress?.spec?.tls;
    if (Array.isArray(tls) && tls.length) {
      tlsBlockPresent = true;
      secretName = String(tls[0]?.secretName ?? '');
    }
  }
  const legacyIntact = sealedPresent && tlsBlockPresent && secretName === LEGACY_TLS_SECRET;
  return { sealedPresent, tlsBlockPresent, secretName, legacyIntact, ingressPresent: ingressText !== null };
}

export function checkGitOpsTls(root, receiptPath) {
  const errors = [];
  const lines = [];
  const receipt = readReceipt(receiptPath);
  const receiptValid = receipt.present && receipt.errors.length === 0;
  if (receipt.present && receipt.errors.length) {
    errors.push(...receipt.errors.map((e) => 'cutover receipt: ' + e));
  }

  // Scan every desired-state file for competing issuers, duplicate Secret
  // writers, cert-manager installation and raw key material.
  walkTree(root, 'base', scanFile);
  walkTree(root, 'environments', scanFile);
  walkTree(root, 'argocd', scanFile);

  function scanFile(relative, text) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
      errors.push(`${relative}: raw private key material in GitOps`);
    }
    if (relative.endsWith('.json')) {
      let doc;
      try { doc = JSON.parse(text); } catch { return; }
      checkSecretWriter(relative, doc);
      return;
    }
    if (!relative.endsWith('.yaml') && !relative.endsWith('.yml')) return;
    let docs;
    try { docs = parseYamlDocuments(text); } catch { return; }
    for (const doc of docs) {
      const kind = String(doc?.kind ?? '');
      if (FORBIDDEN_KINDS.has(kind)) {
        errors.push(`${relative}: competing ${kind} — cert-manager issuance is owned by nitops`);
      }
      if (/cert-manager/.test(text) && (kind === 'Application' || kind === 'Deployment' ||
          kind === 'Namespace' || kind === 'HelmRelease')) {
        errors.push(`${relative}: cert-manager installation in Nession — single owner is nitops`);
      }
      checkSecretWriter(relative, doc);
    }
  }

  function checkSecretWriter(relative, doc) {
    const kind = String(doc?.kind ?? '');
    if (kind !== 'SealedSecret' && kind !== 'Secret') return;
    const template = doc?.spec?.template ?? doc?.template ?? {};
    const namespace = String(template?.metadata?.namespace ?? doc?.metadata?.namespace ?? '');
    const name = String(template?.metadata?.name ?? doc?.metadata?.name ?? '');
    if (namespace === NITOPS_NAMESPACE) {
      errors.push(`${relative}: Nession writes Secret ${name} into nitops-owned namespace ${NITOPS_NAMESPACE}`);
    }
    // The legacy staging MCP TLS Secret is the one Nession-owned TLS writer;
    // any other TLS Secret targeting the wildcard zone is a duplicate writer.
    if (kind === 'SealedSecret' && /bestnathan/.test(name) && name !== LEGACY_TLS_SECRET) {
      errors.push(`${relative}: duplicate TLS Secret writer ${name} for bestnathan.top`);
    }
  }

  // Readiness-gated retirement / consumption switch.
  const state = stagingTlsState(root);
  if (!state.ingressPresent) {
    errors.push(`${STAGING_MCP_INGRESS}: staging MCP ingress missing`);
  } else if (state.legacyIntact) {
    lines.push('staging/mcp: legacy Origin CA TLS intact (pre-cutover); retirement not attempted');
  } else {
    // Any departure from the legacy state — retiring sealed-tls, removing the
    // Higress TLS block (TLS consumed at SLB), or switching secretName — is the
    // cutover. It is blocked until a valid readback receipt is recorded.
    if (!receiptValid) {
      errors.push(
        'staging/mcp: legacy TLS retirement / consumption switch is BLOCKED — ' +
        'a valid cutover readback receipt must be recorded first ' +
        `(receipt ${receipt.present ? 'invalid' : 'absent'}: ${DEFAULT_RECEIPT})`,
      );
    } else {
      lines.push('staging/mcp: legacy TLS retired / consumption switched with recorded cutover readback');
    }
    if (state.sealedPresent && !state.tlsBlockPresent) {
      errors.push('staging/mcp: sealed-tls.json present but ingress TLS block removed — inconsistent retirement');
    }
  }

  return { lines, errors, receiptValid, legacyIntact: state.legacyIntact };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
function fixtureTree() {
  return {
    'base/nession/ingress-server.yaml': `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nession-server
  annotations:
    higress.io/domain: "nession.nhome.local nession.bestnathan.top"
spec:
  ingressClassName: higress
  rules:
    - host: nession.bestnathan.top
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: nession-server
                port:
                  number: 10080
`,
    [LEGACY_TLS_RESOURCE]: JSON.stringify({
      kind: 'SealedSecret',
      apiVersion: 'bitnami.com/v1alpha1',
      metadata: { name: LEGACY_TLS_SECRET, namespace: 'nession' },
      spec: {
        template: { metadata: { name: LEGACY_TLS_SECRET, namespace: 'nession' }, type: 'kubernetes.io/tls' },
        encryptedData: { 'tls.crt': 'AgB ciphertext', 'tls.key': 'AgB ciphertext' },
      },
    }, null, 2),
    [STAGING_MCP_INGRESS]: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nession-mcp-staging
  annotations:
    higress.io/domain: "staging-mcp-nession.bestnathan.top"
spec:
  ingressClassName: higress
  tls:
    - hosts:
        - staging-mcp-nession.bestnathan.top
      secretName: ${LEGACY_TLS_SECRET}
  rules:
    - host: staging-mcp-nession.bestnathan.top
      http:
        paths:
          - path: /mcp
            pathType: Exact
            backend:
              service:
                name: nession-mcp-staging
                port:
                  number: 9090
`,
    'environments/production/mcp/kustomization.yaml': `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: nession
resources:
- deployment.yaml
- service.yaml
`,
  };
}

function validReceipt() {
  return {
    kind: 'tls-cutover-readback',
    issue: 4588,
    gitopsRevision: 'a'.repeat(40),
    sourceRevision: 'b'.repeat(40),
    gatewayIdentity: 'nitops slb nginx (hostNetwork 443) -> Higress HTTP',
    certificate: {
      subject: '*.bestnathan.top',
      issuer: "Let's Encrypt Authority X3",
      serial: '04ab12cd34ef',
      notBefore: '2026-11-27T00:00:00Z',
      notAfter: '2027-02-25T00:00:00Z',
      san: ['*.bestnathan.top', 'bestnathan.top'],
      chainVerified: true,
      publiclyTrusted: true,
    },
    noRemainingConsumer: true,
    run: { id: 1234567890, attempt: 1 },
    verifiedAt: '2026-11-27T01:00:00Z',
  };
}

function writeTree(root, tree) {
  for (const [relative, text] of Object.entries(tree)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

export function selfTest() {
  const os = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'gitops-tls-contract-'));
  const cases = [];
  const run = (name, mutate, receipt, expectReject) => {
    const root = path.join(os, name.replace(/[^a-z0-9]+/gi, '-'));
    const tree = fixtureTree();
    if (mutate) mutate(tree);
    writeTree(root, tree);
    const receiptPath = path.join(root, 'receipt.json');
    if (receipt !== null) fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    let errors = [];
    try {
      errors = checkGitOpsTls(root, receiptPath).errors;
    } catch (error) {
      errors = [error.message];
    }
    const rejected = errors.length > 0;
    if (rejected !== expectReject) {
      fail(`self-test ${name}: expected ${expectReject ? 'rejection' : 'acceptance'}, got ${JSON.stringify(errors)}`);
    }
    cases.push(name);
    fs.rmSync(root, { recursive: true, force: true });
  };

  const retire = (tree) => {
    delete tree[LEGACY_TLS_RESOURCE];
    tree[STAGING_MCP_INGRESS] = tree[STAGING_MCP_INGRESS]
      .replace(/  tls:\n    - hosts:\n        - staging-mcp-nession\.bestnathan\.top\n      secretName: nession-mcp-staging-tls\n/, '');
  };

  run('legacy-intact-no-receipt', null, null, false);
  run('legacy-intact-valid-receipt', null, validReceipt(), false);
  run('retirement-blocked-no-receipt', retire, null, true);
  run('retirement-allowed-with-receipt', retire, validReceipt(), false);
  run('consumption-switch-blocked', (tree) => {
    tree[STAGING_MCP_INGRESS] = tree[STAGING_MCP_INGRESS]
      .replace('secretName: nession-mcp-staging-tls', 'secretName: bestnathan-top-wildcard-tls');
  }, null, true);
  run('consumption-switch-allowed-with-receipt', (tree) => {
    tree[STAGING_MCP_INGRESS] = tree[STAGING_MCP_INGRESS]
      .replace('secretName: nession-mcp-staging-tls', 'secretName: bestnathan-top-wildcard-tls');
  }, validReceipt(), false);
  run('rollback-to-legacy-always-allowed', (tree) => {
    retire(tree);
    // restore legacy state (rollback) — no receipt required
    const fresh = fixtureTree();
    tree[LEGACY_TLS_RESOURCE] = fresh[LEGACY_TLS_RESOURCE];
    tree[STAGING_MCP_INGRESS] = fresh[STAGING_MCP_INGRESS];
  }, null, false);
  run('competing-clusterissuer', (tree) => {
    tree['base/nession/issuer.yaml'] = 'apiVersion: cert-manager.io/v1\nkind: ClusterIssuer\nmetadata:\n  name: letsencrypt\n';
  }, null, true);
  run('competing-certificate', (tree) => {
    tree['base/nession/certificate.yaml'] = 'apiVersion: cert-manager.io/v1\nkind: Certificate\nmetadata:\n  name: wildcard\nspec:\n  secretName: bestnathan-top-wildcard-tls\n';
  }, null, true);
  run('cert-manager-installation', (tree) => {
    tree['argocd/apps/cert-manager.yaml'] = 'apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: cert-manager\nspec:\n  source:\n    chart: cert-manager\n';
  }, null, true);
  run('duplicate-secret-writer-slb', (tree) => {
    tree['environments/staging/mcp/sealed-wildcard.json'] = JSON.stringify({
      kind: 'SealedSecret',
      metadata: { name: 'bestnathan-top-wildcard-tls', namespace: 'slb' },
      spec: { template: { metadata: { name: 'bestnathan-top-wildcard-tls', namespace: 'slb' } } },
    });
  }, null, true);
  run('raw-private-key', (tree) => {
    tree['environments/staging/mcp/key.pem'] = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n';
  }, null, true);
  run('retirement-malformed-receipt-san', retire, { ...validReceipt(), certificate: { ...validReceipt().certificate, san: ['nession.bestnathan.top'] } }, true);
  run('retirement-receipt-untrusted', retire, { ...validReceipt(), certificate: { ...validReceipt().certificate, publiclyTrusted: false } }, true);
  run('retirement-receipt-consumer-remains', retire, { ...validReceipt(), noRemainingConsumer: false }, true);
  run('retirement-receipt-key-material', retire, { ...validReceipt(), privateKey: '-----BEGIN PRIVATE KEY-----' }, true);
  run('retirement-receipt-bad-revision', retire, { ...validReceipt(), gitopsRevision: 'not-hex' }, true);

  fs.rmSync(os, { recursive: true, force: true });
  return `gitops-tls-contract self-test: ${cases.length} ownership/readiness/retirement cases proven`;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    console.log(selfTest());
    return;
  }
  let root = null;
  let receiptPath = path.join(repoRoot(), DEFAULT_RECEIPT);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') {
      root = args[index + 1];
      index += 1;
    } else if (args[index] === '--receipt') {
      receiptPath = args[index + 1];
      index += 1;
    } else {
      fail('unknown argument: ' + args[index]);
    }
  }
  if (!root) fail('usage: gitops-tls-contract.mjs --root <gitops-checkout> [--receipt <path>] | --self-test');
  const result = checkGitOpsTls(root, receiptPath);
  for (const line of result.lines) console.log(line);
  if (result.errors.length) {
    for (const error of result.errors) console.error('gitops-tls-contract: ' + error);
    process.exitCode = 1;
    return;
  }
  console.log('gitops-tls-contract: single nitops certificate ownership, no duplicate writer, retirement readiness-gated');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error('gitops-tls-contract: ' + (error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// Offline one-to-one SealedSecret producer from raw GitHub Environment Secret.
// Names and paths come ONLY from this reviewed allowlist (#3912).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TARGETS = Object.freeze({
  staging: Object.freeze({
    MCP_INBOUND_TOKEN: Object.freeze({
      namespace: 'nession',
      name: 'nession-mcp-inbound-staging',
      key: 'token',
      type: 'Opaque',
      resource: 'environments/staging/mcp/sealed-inbound.json',
      kustomization: 'environments/staging/mcp/kustomization.yaml'
    }),
    // Legacy config SealedSecret remains registered for rollback only; the
    // protected manual producer no longer publishes plaintext TOML bundles.
    MCP_CONFIG_TOML: Object.freeze({
      namespace: 'nession',
      name: 'nession-mcp-config-staging',
      key: 'mcp.toml',
      type: 'Opaque',
      resource: 'environments/staging/mcp/sealed-secret.json',
      kustomization: 'environments/staging/mcp/kustomization.yaml'
    }),
    MCP_TLS_PEM_BUNDLE: Object.freeze({
      namespace: 'nession',
      name: 'nession-mcp-staging-tls',
      keys: Object.freeze(['tls.crt', 'tls.key']),
      type: 'kubernetes.io/tls',
      hostname: 'staging-mcp-nession.bestnathan.top',
      resource: 'environments/staging/mcp/sealed-tls.json',
      kustomization: 'environments/staging/mcp/kustomization.yaml'
    })
  })
});

export function getTarget(environment, secretName) {
  const target = TARGETS[environment]?.[secretName];
  if (!target) throw new Error('unregistered GitOps environment and Secret pairing');
  if (!target.resource.startsWith('environments/' + environment + '/') ||
      !target.kustomization.startsWith('environments/' + environment + '/')) {
    throw new Error('target registry GitOps environment mismatch');
  }
  return target;
}

export function validateRaw(raw) {
  if (typeof raw !== 'string' || raw.length === 0 ||
      Buffer.byteLength(raw, 'utf8') > 131072 || raw.includes('\0')) {
    throw new Error('missing, oversized or invalid raw Environment Secret');
  }
  return raw;
}


// A raw Environment Secret is a PEM certificate fullchain followed by exactly
// one matching, unencrypted private key. This is one GH Secret -> one K8s TLS
// Secret (two mandatory data keys); it is NOT a JSON bundle or a second owner
// of the controller's public sealing certificate.
export function parseTlsPemBundle(raw, hostname) {
  validateRaw(raw);
  if (typeof hostname !== 'string' || !hostname) {
    throw new Error('TLS hostname must be a registered exact hostname');
  }
  const pemBlocks = [];
  const pattern = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
  let cursor = 0;
  for (const match of raw.matchAll(pattern)) {
    if (raw.slice(cursor, match.index).trim()) {
      throw new Error('Unexpected content outside TLS PEM blocks');
    }
    pemBlocks.push({ kind: match[1], text: match[0] + '\n' });
    cursor = match.index + match[0].length;
  }
  if (!pemBlocks.length || raw.slice(cursor).trim()) {
    throw new Error('TLS PEM bundle is incomplete or contains unexpected material');
  }
  const certBlocks = pemBlocks.filter(block => block.kind === 'CERTIFICATE');
  const keys = pemBlocks.filter(block =>
    ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY'].includes(block.kind));
  if (!certBlocks.length || keys.length !== 1 ||
      pemBlocks.length !== certBlocks.length + 1 ||
      pemBlocks[pemBlocks.length - 1] !== keys[0] ||
      pemBlocks.slice(0, -1).some(block => block.kind !== 'CERTIFICATE')) {
    throw new Error('TLS PEM bundle requires leaf/fullchain then one unencrypted private key');
  }
  let certificates, key;
  try {
    certificates = certBlocks.map(block => new X509Certificate(block.text));
    key = createPrivateKey(keys[0].text);
  } catch {
    throw new Error('Invalid TLS certificate or unencrypted private key');
  }
  const leaf = certificates[0];
  // Avoid Subject Common Name fallback: public TLS identity must be in SAN.
  if (!leaf.checkHost(hostname, { subject: 'never' })) {
    throw new Error('TLS leaf certificate does not cover registered hostname');
  }
  const now = Date.now();
  if (!(Date.parse(leaf.validFrom) <= now) ||
      !(Date.parse(leaf.validTo) > now + 7 * 86400000)) {
    throw new Error('TLS leaf certificate is not yet valid or expires within seven days');
  }
  if (!leaf.checkPrivateKey(key)) {
    throw new Error('TLS certificate does not match private key');
  }
  for (let i = 0; i < certificates.length - 1; i++) {
    if (!certificates[i].checkIssued(certificates[i + 1]) ||
        !certificates[i].verify(certificates[i + 1].publicKey)) {
      throw new Error('TLS certificate chain is invalid or out of order');
    }
  }
  return {
    certificateChain: certBlocks.map(block => block.text).join(''),
    privateKey: keys[0].text
  };
}

function expectedEncryptedKeys(target) {
  return target.keys ?? [target.key];
}

export function createPlainSecret(environment, secretName, raw) {
  const target = getTarget(environment, secretName);
  // Inbound Bearer credentials must be single-line, visible text; a missing
  // or whitespace-only Environment Secret never becomes a usable key.
  if (secretName === 'MCP_INBOUND_TOKEN' &&
      (typeof raw !== 'string' || !/^[!-~]+$/.test(raw) || raw.length > 4096)) {
    throw new Error('MCP inbound credential must be a nonempty single-line printable token');
  }
  const data = target.type === 'kubernetes.io/tls'
    ? (() => {
        const pem = parseTlsPemBundle(raw, target.hostname);
        return {
          'tls.crt': Buffer.from(pem.certificateChain, 'utf8').toString('base64'),
          'tls.key': Buffer.from(pem.privateKey, 'utf8').toString('base64')
        };
      })()
    : { [target.key]: Buffer.from(validateRaw(raw), 'utf8').toString('base64') };
  return {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: target.name, namespace: target.namespace },
    type: target.type, data
  };
}

export function validatePublicCert(pem) {
  if (typeof pem !== 'string' || pem.length > 131072 ||
      !pem.includes('-----BEGIN CERTIFICATE-----') ||
      !pem.includes('-----END CERTIFICATE-----') || pem.includes('PRIVATE KEY')) {
    throw new Error('Sealed Secrets requires its controller X.509 public certificate, not an SSH key');
  }
  let cert;
  try { cert = new X509Certificate(pem); }
  catch { throw new Error('Invalid X.509 public certificate'); }
  if (cert.publicKey.asymmetricKeyType !== 'rsa') {
    throw new Error('Sealed Secrets requires its controller RSA public certificate');
  }
  if (new Date(cert.validTo).getTime() <= Date.now() + 86400000) {
    throw new Error('Sealing certificate expired or expires within 24 hours');
  }
  return pem;
}

export function validateSealed(doc, environment, secretName) {
  const target = getTarget(environment, secretName);
  if (doc?.apiVersion !== 'bitnami.com/v1alpha1' || doc?.kind !== 'SealedSecret' ||
      doc?.metadata?.namespace !== target.namespace ||
      doc?.metadata?.name !== target.name) {
    throw new Error('SealedSecret Kubernetes identity mismatch');
  }
  const encrypted = doc.spec?.encryptedData;
  const expectedKeys = expectedEncryptedKeys(target);
  if (!encrypted || typeof encrypted !== 'object' || Array.isArray(encrypted) ||
      Object.keys(encrypted).length !== expectedKeys.length ||
      expectedKeys.some(key => typeof encrypted[key] !== 'string' || !encrypted[key])) {
    throw new Error('SealedSecret must have only the exact registered encrypted data keys');
  }
  const template = doc.spec?.template;
  if ((target.type === 'kubernetes.io/tls' && template?.type !== target.type) ||
      (template?.metadata?.name && template.metadata.name !== target.name) ||
      (template?.metadata?.namespace && template.metadata.namespace !== target.namespace) ||
      (template?.type && template.type !== target.type) ||
      template?.data || template?.stringData ||
      doc.spec?.data || doc.spec?.stringData) {
    throw new Error('Unsafe SealedSecret plaintext/template metadata');
  }
  for (const m of [doc.metadata, template?.metadata]) {
    const annotations = m?.annotations || {};
    if (annotations['sealedsecrets.bitnami.com/cluster-wide'] === 'true' ||
        annotations['sealedsecrets.bitnami.com/namespace-wide'] === 'true' ||
        (annotations['sealedsecrets.bitnami.com/scope'] &&
         annotations['sealedsecrets.bitnami.com/scope'] !== 'strict')) {
      throw new Error('Only strict SealedSecret scope is permitted');
    }
  }
  return doc;
}

export function addResource(yaml, resource) {
  const filename = path.posix.basename(resource);
  if (!['sealed-secret.json', 'sealed-inbound.json', 'sealed-tls.json'].includes(filename)) {
    throw new Error('unsupported resource name');
  }
  if (!/^resources:\s*$/m.test(yaml)) throw new Error('Kustomization resources list absent');
  const resources = yaml.split(/\r?\n/);
  if (resources.some(line => line.trim() === '- ' + filename)) return yaml;
  return yaml.replace(/^resources:\s*\r?\n/m, 'resources:\n  - ' + filename + '\n');
}


// Git porcelain is two status columns + one space + path. Do not call
// trim() on its output; a leading blank status column is semantically useful.
export function parseGitStatusPaths(raw) {
  if (typeof raw !== 'string') throw new Error('Git status output must be text');
  return raw.split(/\r?\n/).filter(Boolean).map(line => {
    if (!/^[ MADRCU?!]{2} /.test(line)) {
      throw new Error('Invalid git status --porcelain=v1 record');
    }
    return line.slice(3);
  });
}

export function validateChangedPaths(changedPaths, environment, secretName) {
  const target = getTarget(environment, secretName);
  const expected = new Set([target.resource, target.kustomization]);
  if (!Array.isArray(changedPaths) ||
      changedPaths.some(p => typeof p !== 'string' || !expected.has(p))) {
    throw new Error('GitOps checkout contains changes outside this exact Secret target');
  }
  return changedPaths;
}

function publish(root, environment, secretName) {
  const target = getTarget(environment, secretName);
  if (!root || !fs.existsSync(path.join(root, '.git'))) {
    throw new Error('GitOps checkout required for bounded desired-state publication');
  }
  // The GitOps branch checkout is data only: never execute any code from it.
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  if (git('branch', '--show-current') !== 'gitops') {
    throw new Error('Publication must target the checked-out gitops branch');
  }
  // Keep leading porcelain status columns: git() trims whitespace and would
  // corrupt the first path when Git starts with an unstaged " M ..." line.
  const porcelain = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const paths = parseGitStatusPaths(porcelain);
  validateChangedPaths(paths, environment, secretName);
  if (!paths.includes(target.resource)) {
    throw new Error('Expected encrypted SealedSecret resource was not generated');
  }
  const sealed = JSON.parse(fs.readFileSync(path.join(root, target.resource), 'utf8'));
  validateSealed(sealed, environment, secretName);
  git('add', '--', target.resource, target.kustomization);
  if (!git('diff', '--cached', '--name-only')) {
    console.log('Encrypted GitOps desired state already up-to-date');
    return;
  }
  git('-c', 'user.name=github-actions[bot]',
      '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
      'commit', '-m', 'secrets(' + environment + '): seal ' + secretName + ' (#3912)');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      git('pull', '--rebase', 'origin', 'gitops');
      git('push', 'origin', 'HEAD:gitops');
      console.log('Published only strict, encrypted GitOps desired state');
      return;
    } catch {
      if (fs.existsSync(path.join(root, '.git/rebase-merge')) ||
          fs.existsSync(path.join(root, '.git/rebase-apply'))) {
        try { git('rebase', '--abort'); } catch { /* fail closed */ }
        throw new Error('GitOps rebase conflict; refusing to publish ciphertext');
      }
    }
  }
  throw new Error('Failed to publish encrypted desired state after bounded retries');
}

function execute() {
  const [operation, environment, secretName, root] = process.argv.slice(2);
  const target = getTarget(environment, secretName);
  if (operation === 'verify') {
    console.log('Exact GitOps environment / Secret registration verified');
    return;
  }
  const temp = process.env.RUNNER_TEMP;
  if (!temp) throw new Error('RUNNER_TEMP is required');
  const work = path.join(temp, 'nession-seal');
  if (operation === 'prepare') {
    const value = validateRaw(process.env.SEAL_RAW_VALUE);
    const cert = validatePublicCert(process.env.SEALED_SECRETS_CERT_PEM);
    fs.mkdirSync(work, { mode: 0o700 });
    fs.writeFileSync(path.join(work, 'cert.pem'), cert, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(work, 'secret.json'),
      JSON.stringify(createPlainSecret(environment, secretName, value)),
      { flag: 'wx', mode: 0o600 });
    console.log('Prepared single raw Secret using controller public sealing cert');
    return;
  }
  if (operation === 'publish') {
    publish(root, environment, secretName);
    return;
  }
  if (operation === 'stage') {
    if (!root || !fs.existsSync(path.join(root, '.git'))) throw new Error('GitOps checkout absent');
    const overlay = path.join(root, target.kustomization);
    if (!fs.existsSync(overlay)) throw new Error('Target GitOps overlay absent');
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(work, 'sealed.json'), 'utf8')); }
    catch { throw new Error('kubeseal output is not JSON'); }
    validateSealed(doc, environment, secretName);
    const old = fs.readFileSync(overlay, 'utf8');
    const next = addResource(old, target.resource);
    fs.writeFileSync(path.join(root, target.resource), JSON.stringify(doc, null, 2) + '\n');
    if (next !== old) fs.writeFileSync(overlay, next);
    console.log('Staged one encrypted SealedSecret in allowlisted GitOps overlay');
    return;
  }
  throw new Error('Expected verify, prepare, stage or publish');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { execute(); } catch (error) {
    console.error('SealedSecret generation failed: ' + error.message);
    process.exitCode = 1;
  }
}

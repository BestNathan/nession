#!/usr/bin/env node
// Offline one-to-one SealedSecret producer from raw GitHub Environment Secret.
// Names and paths come ONLY from this reviewed allowlist (#3912).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TARGETS = Object.freeze({
  staging: Object.freeze({
    MCP_CONFIG_TOML: Object.freeze({
      namespace: 'nession',
      name: 'nession-mcp-config-staging',
      key: 'mcp.toml',
      type: 'Opaque',
      resource: 'environments/staging/mcp/sealed-secret.json',
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

export function createPlainSecret(environment, secretName, raw) {
  const target = getTarget(environment, secretName);
  return {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: target.name, namespace: target.namespace },
    type: target.type,
    data: { [target.key]: Buffer.from(validateRaw(raw), 'utf8').toString('base64') }
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
  if (!encrypted || typeof encrypted !== 'object' || Array.isArray(encrypted) ||
      Object.keys(encrypted).length !== 1 ||
      typeof encrypted[target.key] !== 'string' || !encrypted[target.key]) {
    throw new Error('SealedSecret must have exactly one matching encrypted data key');
  }
  const template = doc.spec?.template;
  if ((template?.metadata?.name && template.metadata.name !== target.name) ||
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
  if (filename !== 'sealed-secret.json') throw new Error('unsupported resource name');
  if (!/^resources:\s*$/m.test(yaml)) throw new Error('Kustomization resources list absent');
  if (/^\s*-\s*sealed-secret\.json\s*$/m.test(yaml)) return yaml;
  return yaml.replace(/^resources:\s*\r?\n/m, 'resources:\n  - sealed-secret.json\n');
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
  const paths = git('status', '--porcelain=v1', '--untracked-files=all')
    .split('\n').filter(Boolean).map(line => line.slice(3));
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

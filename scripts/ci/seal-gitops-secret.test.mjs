import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getTarget, validateRaw, createPlainSecret,
  validatePublicCert, validateSealed, addResource
} from './seal-gitops-secret.mjs';

const environment = 'staging', secret = 'MCP_CONFIG_TOML';
const target = getTarget(environment, secret);
const raw = '[mcp]\nauth_token = "inbound"\n[backend.server]\nauth_token = "backend"\n';
const sealed = {
  apiVersion: 'bitnami.com/v1alpha1',
  kind: 'SealedSecret',
  metadata: { name: target.name, namespace: target.namespace },
  spec: {
    encryptedData: { [target.key]: 'AgEncryptedText' },
    template: { metadata: { name: target.name, namespace: target.namespace }, type: 'Opaque' }
  }
};

test('GitHub Environment must match GitOps environment directory exactly', () => {
  assert.equal(target.resource, 'environments/staging/mcp/sealed-secret.json');
  assert.equal(target.namespace, 'nession');
  assert.throws(() => getTarget('staging-mcp', secret));
  assert.throws(() => getTarget('production', secret));
  assert.throws(() => getTarget('staging', 'UNREGISTERED'));
  assert.throws(() => getTarget('../staging', secret));
});

test('one GitHub Secret raw text is copied byte-for-byte into one Kubernetes Secret key', () => {
  const doc = createPlainSecret(environment, secret, raw);
  assert.equal(doc.kind, 'Secret');
  assert.deepEqual(Object.keys(doc.data), ['mcp.toml']);
  assert.equal(Buffer.from(doc.data['mcp.toml'], 'base64').toString(), raw);
  assert.equal(validateRaw('{"this":"is literal data, not a JSON wrapper"}'),
    '{"this":"is literal data, not a JSON wrapper"}');
  assert.throws(() => validateRaw(''));
  assert.throws(() => validateRaw('abc\0def'));
});

test('Argo CD SSH public keys are not Sealed Secrets public certificates', () => {
  assert.throws(() => validatePublicCert('ssh-ed25519 AAAAC3NzaDummyTestPublicKeyMaterial argocd-deploy-key'));
  assert.throws(() => validatePublicCert('-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----'));
});

test('public sealing key must be valid RSA X.509 certificate', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'nession-seal-test-'));
  try {
    const rsa = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
      '-nodes', '-days', '10', '-keyout', path.join(tmp, 'rsa.key'),
      '-out', path.join(tmp, 'rsa.crt'), '-subj', '/CN=test-rsa'], { encoding: 'utf8' });
    assert.equal(rsa.status, 0, rsa.stderr);
    assert.match(validatePublicCert(readFileSync(path.join(tmp, 'rsa.crt'), 'utf8')), /BEGIN CERTIFICATE/);
    const key = spawnSync('openssl', ['genpkey', '-algorithm', 'ED25519',
      '-out', path.join(tmp, 'ed.key')], { encoding: 'utf8' });
    assert.equal(key.status, 0, key.stderr);
    const cert = spawnSync('openssl', ['req', '-x509', '-new',
      '-key', path.join(tmp, 'ed.key'), '-days', '10',
      '-out', path.join(tmp, 'ed.crt'), '-subj', '/CN=wrong-type'], { encoding: 'utf8' });
    assert.equal(cert.status, 0, cert.stderr);
    assert.throws(() => validatePublicCert(readFileSync(path.join(tmp, 'ed.crt'), 'utf8')));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('encrypted output rejects broad scopes, wrong names and plaintext', () => {
  assert.equal(validateSealed(structuredClone(sealed), environment, secret).kind, 'SealedSecret');
  const wrong = structuredClone(sealed); wrong.metadata.name = 'wrong';
  assert.throws(() => validateSealed(wrong, environment, secret));
  const broad = structuredClone(sealed);
  broad.metadata.annotations = { 'sealedsecrets.bitnami.com/cluster-wide': 'true' };
  assert.throws(() => validateSealed(broad, environment, secret));
  const plaintext = structuredClone(sealed);
  plaintext.spec.template.stringData = { 'mcp.toml': raw };
  assert.throws(() => validateSealed(plaintext, environment, secret));
  const extra = structuredClone(sealed); extra.spec.encryptedData.foo = 'secret';
  assert.throws(() => validateSealed(extra, environment, secret));
});

test('Kustomize resource enrollment is idempotent', () => {
  const yaml = 'resources:\n  - deployment.yaml\n\nimages:\n  - name: mcp\n';
  const once = addResource(yaml, target.resource);
  assert.match(once, /- sealed-secret\.json/);
  assert.equal(addResource(once, target.resource), once);
  assert.throws(() => addResource('images: []\n', target.resource));
});

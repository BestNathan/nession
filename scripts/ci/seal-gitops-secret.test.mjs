import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTarget, parsePayload, makeSecret, publicCert, checkSealed, addResource } from './seal-gitops-secret.mjs';
const t = getTarget('staging-mcp');
const plain = '[mcp]\nauth_token = "inbound"\nallowed_hosts = ["staging.mcp.nession.bestnathan.top"]\n[backend.server]\nauth_token = "backend"\n';
const payload = JSON.stringify({ 'mcp.toml': plain });
const doc = { apiVersion: 'bitnami.com/v1alpha1', kind: 'SealedSecret',
  metadata: { name: t.name, namespace: t.namespace },
  spec: { encryptedData: { 'mcp.toml': 'encrypted-opaque-value' },
    template: { metadata: { name: t.name, namespace: t.namespace }, type: 'Opaque' } } };
test('target only allows configured namespace and name', () => {
  assert.equal(t.namespace, 'nession'); assert.equal(t.name, 'nession-mcp-config-staging');
  assert.throws(() => getTarget('production')); assert.throws(() => getTarget('../prod'));
});
test('payload must match target keys and contain authentication', () => {
  assert.equal(parsePayload(payload, 'staging-mcp')['mcp.toml'], plain);
  for (const s of ['{}', '[]', '{', '{"mcp.toml":""}', JSON.stringify({ 'mcp.toml': plain, other: 'secret' })])
    assert.throws(() => parsePayload(s, 'staging-mcp'));
});
test('plaintext is only materialized as a temporary Secret', () => {
  const manifest = makeSecret('staging-mcp', parsePayload(payload, 'staging-mcp'));
  assert.equal(Buffer.from(manifest.data['mcp.toml'], 'base64').toString(), plain);
  assert.ok(!JSON.stringify(manifest).includes(plain));
});
test('public certificate rejects controller private key', () => {
  const cert = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
  assert.equal(publicCert(Buffer.from(cert).toString('base64')), cert);
  assert.throws(() => publicCert(Buffer.from('-----BEGIN PRIVATE KEY-----').toString('base64')));
});
test('sealed output refuses broad scopes, plaintext and altered identity', () => {
  assert.equal(checkSealed(structuredClone(doc), 'staging-mcp').kind, 'SealedSecret');
  const broad = structuredClone(doc); broad.metadata.annotations = { 'sealedsecrets.bitnami.com/cluster-wide': 'true' };
  assert.throws(() => checkSealed(broad, 'staging-mcp'));
  const wrong = structuredClone(doc); wrong.metadata.name = 'another';
  assert.throws(() => checkSealed(wrong, 'staging-mcp'));
  const unsealed = structuredClone(doc); unsealed.spec.template.data = { a: 'plaintext' };
  assert.throws(() => checkSealed(unsealed, 'staging-mcp'));
});
test('Kustomize resource enrollment is idempotent', () => {
  const yaml = 'resources:\n  - deployment.yaml\n\nimages:\n  - name: mcp\n';
  assert.equal(addResource(addResource(yaml)), addResource(yaml));
  assert.match(addResource(yaml), /- sealed-secret\.json/);
  assert.throws(() => addResource('images: []\n'));
});

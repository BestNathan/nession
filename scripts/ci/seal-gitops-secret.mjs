#!/usr/bin/env node
// SealedSecret producer. Trusted main workflow only; never print plaintext (#3912).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGETS = Object.freeze({
  'staging-mcp': {
    namespace: 'nession', name: 'nession-mcp-config-staging',
    keys: ['mcp.toml'], type: 'Opaque',
    resource: 'environments/staging/mcp/sealed-secret.json',
    kustomization: 'environments/staging/mcp/kustomization.yaml'
  }
});
export function getTarget(name) {
  if (!Object.hasOwn(TARGETS, name)) throw new Error('target is not allowlisted');
  return TARGETS[name];
}
export function parsePayload(raw, targetName) {
  const target = getTarget(targetName);
  if (!raw || Buffer.byteLength(raw) > 131072) throw new Error('missing/oversize Environment Secret');
  let obj;
  try { obj = JSON.parse(raw); } catch { throw new Error('Environment Secret is not valid JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON payload must be an object');
  const keys = Object.keys(obj).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...target.keys].sort())) throw new Error('unexpected Secret keys');
  for (const key of keys) if (typeof obj[key] !== 'string' || !obj[key]) throw new Error('Secret values must be nonempty strings');
  if (targetName === 'staging-mcp') {
    const toml = obj['mcp.toml'];
    if (!toml.includes('[mcp]') || !toml.includes('[backend.server]') ||
        !toml.includes('staging.mcp.nession.bestnathan.top') ||
        (toml.match(/^\s*auth_token\s*=/gm) || []).length < 2 ||
        /^\s*auth_token\s*=\s*""\s*$/m.test(toml)) {
      throw new Error('staging MCP auth/Host configuration is incomplete');
    }
  }
  return obj;
}
export function makeSecret(name, payload) {
  const target = getTarget(name);
  const data = {};
  for (const key of target.keys) data[key] = Buffer.from(payload[key]).toString('base64');
  return { apiVersion: 'v1', kind: 'Secret',
    metadata: { name: target.name, namespace: target.namespace },
    type: target.type, data };
}
export function publicCert(base64) {
  if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64) || base64.length > 131072) {
    throw new Error('invalid public certificate encoding');
  }
  const pem = Buffer.from(base64, 'base64').toString('utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE-----') ||
      !pem.includes('-----END CERTIFICATE-----') || pem.includes('PRIVATE KEY')) {
    throw new Error('a public sealing certificate is required, not a private key');
  }
  return pem;
}
export function checkSealed(doc, name) {
  const target = getTarget(name);
  if (doc?.apiVersion !== 'bitnami.com/v1alpha1' || doc?.kind !== 'SealedSecret' ||
      doc?.metadata?.name !== target.name || doc?.metadata?.namespace !== target.namespace) {
    throw new Error('SealedSecret identity mismatch');
  }
  const enc = doc.spec?.encryptedData;
  if (!enc || typeof enc !== 'object' || Array.isArray(enc) ||
      JSON.stringify(Object.keys(enc).sort()) !== JSON.stringify([...target.keys].sort()) ||
      Object.values(enc).some(x => typeof x !== 'string' || !x)) {
    throw new Error('invalid encryptedData');
  }
  const tmpl = doc.spec?.template;
  if ((tmpl?.metadata?.name && tmpl.metadata.name !== target.name) ||
      (tmpl?.metadata?.namespace && tmpl.metadata.namespace !== target.namespace) ||
      (tmpl?.type && tmpl.type !== target.type) ||
      tmpl?.data || tmpl?.stringData || doc.spec?.data || doc.spec?.stringData) {
    throw new Error('unsafe SealedSecret template');
  }
  for (const m of [doc.metadata, tmpl?.metadata]) {
    const a = m?.annotations || {};
    if (a['sealedsecrets.bitnami.com/cluster-wide'] === 'true' ||
        a['sealedsecrets.bitnami.com/namespace-wide'] === 'true' ||
        (a['sealedsecrets.bitnami.com/scope'] && a['sealedsecrets.bitnami.com/scope'] !== 'strict')) {
      throw new Error('only strict scope is permitted');
    }
  }
  return doc;
}
export function addResource(yaml) {
  if (!/^resources:\s*$/m.test(yaml)) throw new Error('target overlay is not a Kustomization');
  if (/^\s*-\s*sealed-secret\.json\s*$/m.test(yaml)) return yaml;
  return yaml.replace(/^resources:\s*\r?\n/m, 'resources:\n  - sealed-secret.json\n');
}
function execute() {
  const [mode, name, root] = process.argv.slice(2);
  const target = getTarget(name);
  const temp = process.env.RUNNER_TEMP;
  if (!temp) throw new Error('runner temp directory required');
  const work = path.join(temp, 'nession-seal');
  if (mode === 'prepare') {
    const payload = parsePayload(process.env.K8S_SECRET_DATA_JSON, name);
    const cert = publicCert(process.env.SEALED_SECRETS_CERT_B64);
    fs.mkdirSync(work, { mode: 0o700 });
    fs.writeFileSync(path.join(work, 'cert.pem'), cert, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(work, 'secret.json'), JSON.stringify(makeSecret(name, payload)), { mode: 0o600, flag: 'wx' });
    console.log('Prepared offline sealing inputs for allowlisted target');
  } else if (mode === 'stage') {
    if (!root || !fs.existsSync(path.join(root, '.git'))) throw new Error('GitOps checkout missing');
    const overlay = path.join(root, target.kustomization);
    if (!fs.existsSync(overlay)) throw new Error('GitOps target overlay missing; merge workload overlay first');
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(work, 'sealed.json'), 'utf8')); }
    catch { throw new Error('kubeseal did not emit JSON'); }
    const sealed = checkSealed(doc, name);
    const old = fs.readFileSync(overlay, 'utf8');
    const next = addResource(old);
    fs.writeFileSync(path.join(root, target.resource), JSON.stringify(sealed, null, 2) + '\n');
    if (old !== next) fs.writeFileSync(overlay, next);
    console.log('Staged only encrypted GitOps resource: ' + target.resource);
  } else throw new Error('expected prepare or stage');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { execute(); } catch (e) { console.error('SealedSecret step failed: ' + e.message); process.exitCode = 1; }
}

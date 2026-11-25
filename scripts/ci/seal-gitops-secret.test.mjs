import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getTarget, validateRaw, createPlainSecret, parseTlsPemBundle,
  validatePublicCert, validateSealed, addResource, validateChangedPaths, parseGitStatusPaths,
  getRequiredSecrets, prepareRequiredSecrets, addRequiredResources,
  validateChangedPathsForRequired, stageRequired
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

test('SealedSecret enrollment preserves existing indentless and indented YAML lists', () => {
  const resource = 'environments/staging/mcp/sealed-inbound.json';
  const originalIndentless =
    'resources:\n- sealed-tls.json\n- sealed-secret.json\n- deployment.yaml\n\nimages:\n- name: mcp\n';
  const rootStyle = addResource(originalIndentless, resource);
  assert.match(rootStyle, /^resources:\n- sealed-inbound\.json\n- sealed-tls\.json\n/m);
  assert.equal(addResource(rootStyle, resource), rootStyle);
  assert.equal(rootStyle.includes('\n  - sealed-inbound.json\n'), false);
  const twoSpace =
    'resources:\n  - sealed-tls.json\n  - sealed-secret.json\n  - deployment.yaml\n\nimages:\n- name: mcp\n';
  const nestedStyle = addResource(twoSpace, resource);
  assert.match(nestedStyle, /^resources:\n  - sealed-inbound\.json\n  - sealed-tls\.json\n/m);
  assert.equal(addResource(nestedStyle, resource), nestedStyle);
  assert.throws(() => addResource('resources:\nimages:\n- name: mcp\n', resource),
    /empty or malformed/);
  const batch = addRequiredResources(originalIndentless, 'staging');
  assert.match(batch, /^resources:\n- sealed-backend-server\.json\n- sealed-inbound\.json\n- sealed-tls\.json\n/m);
  assert.equal(addRequiredResources(batch, 'staging'), batch);
  const batchNested = addRequiredResources(twoSpace, 'staging');
  assert.match(batchNested,
    /^resources:\n  - sealed-backend-server\.json\n  - sealed-inbound\.json\n  - sealed-tls\.json\n/m);
  assert.equal(addRequiredResources(batchNested, 'staging'), batchNested);
  // Every resource item must keep the existing sequence indentation.
  const rows = value => value.split(/\nimages:/)[0].split('\n').filter(line => /^\s*-\s+/.test(line));
  assert.ok(rows(batch).every(line => line.startsWith('- ')));
  assert.ok(rows(batchNested).every(line => line.startsWith('  - ')));
});

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


test('GitOps publisher allows only the exact reviewed two-file output', () => {
  const base = ['environments/staging/mcp/sealed-secret.json',
    'environments/staging/mcp/kustomization.yaml'];
  assert.deepEqual(validateChangedPaths(base, environment, secret), base);
  assert.throws(() => validateChangedPaths([...base, 'environments/staging/nession/secret.yaml'], environment, secret));
  assert.throws(() => validateChangedPaths(['environments/production/mcp/sealed-secret.json'], environment, secret));
  assert.throws(() => validateChangedPaths(['.github/workflows/deploy.yml'], environment, secret));
});

test('Git porcelain parser preserves leading tracked-status columns', () => {
  const base = 'environments/staging/mcp/';
  const raw = [' M ' + base + 'kustomization.yaml',
    '?? ' + base + 'sealed-secret.json', ''].join('\n');
  const paths = parseGitStatusPaths(raw);
  assert.deepEqual(paths, [base + 'kustomization.yaml', base + 'sealed-secret.json']);
  assert.deepEqual(validateChangedPaths(paths, environment, secret), paths);
  assert.throws(() => parseGitStatusPaths('bogus porcelain record\n'));
  assert.throws(() => validateChangedPaths(
    parseGitStatusPaths(' M environments/staging/nession/secret.yaml\n'), environment, secret));
});

test('Git porcelain staged status and mixed status preserve exact file identities', () => {
  const root = 'environments/staging/mcp/';
  const rows = ['M  ' + root + 'kustomization.yaml',
    '?? ' + root + 'sealed-secret.json', ''];
  const parsed = parseGitStatusPaths(rows.join('\n'));
  assert.deepEqual(parsed, [root + 'kustomization.yaml', root + 'sealed-secret.json']);
  assert.deepEqual(validateChangedPaths(parsed, environment, secret), parsed);
});


const tlsSecret = 'MCP_TLS_PEM_BUNDLE';
const tlsTarget = getTarget(environment, tlsSecret);
const tlsHostname = 'staging-mcp-nession.bestnathan.top';

function generateTlsFixture(directory, label, host = tlsHostname, days = 30) {
  const crt = path.join(directory, label + '.crt');
  const key = path.join(directory, label + '.key');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-nodes', '-days', String(days), '-keyout', key, '-out', crt,
    '-subj', '/CN=' + host, '-addext', 'subjectAltName=DNS:' + host],
  { encoding: 'utf8' });
  assert.equal(r.status, 0, 'OpenSSL fixture generation failed');
  return {
    crt: readFileSync(crt, 'utf8'),
    key: readFileSync(key, 'utf8')
  };
}

test('TLS target is one exact-name, two-key Kubernetes TLS Secret', () => {
  assert.deepEqual(tlsTarget.keys, ['tls.crt', 'tls.key']);
  assert.equal(tlsTarget.type, 'kubernetes.io/tls');
  assert.equal(tlsTarget.namespace, 'nession');
  assert.equal(tlsTarget.name, 'nession-mcp-staging-tls');
  assert.equal(tlsTarget.resource, 'environments/staging/mcp/sealed-tls.json');
  assert.throws(() => getTarget('production', tlsSecret));
  assert.throws(() => getTarget('staging', 'MCP_TLS_PRIVATE_KEY'));
});

test('TLS PEM fullchain + key validates and produces a single TLS Secret without plaintext', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'nession-tls-valid-'));
  try {
    const {crt, key} = generateTlsFixture(tmp, 'leaf');
    const raw = crt + key;
    const decoded = parseTlsPemBundle(raw, tlsHostname);
    assert.equal(decoded.certificateChain.trim(), crt.trim());
    assert.equal(decoded.privateKey.trim(), key.trim());
    const plain = createPlainSecret(environment, tlsSecret, raw);
    assert.equal(plain.type, 'kubernetes.io/tls');
    assert.equal(plain.metadata.name, tlsTarget.name);
    assert.deepEqual(Object.keys(plain.data).sort(), ['tls.crt', 'tls.key']);
    assert.equal(Buffer.from(plain.data['tls.crt'], 'base64').toString(), crt);
    assert.equal(Buffer.from(plain.data['tls.key'], 'base64').toString(), key);
    assert.doesNotMatch(JSON.stringify(plain), /BEGIN PRIVATE KEY/);
  } finally { rmSync(tmp, {recursive: true, force: true}); }
});

test('TLS PEM rejects unrelated identity, mismatch, extra material and expiring certs', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'nession-tls-negative-'));
  try {
    const a = generateTlsFixture(tmp, 'a');
    const b = generateTlsFixture(tmp, 'b', 'other.example.com');
    const soon = generateTlsFixture(tmp, 'soon', tlsHostname, 1);
    const raw = a.crt + a.key;
    assert.throws(() => parseTlsPemBundle(raw, 'other.example.com'));
    assert.throws(() => parseTlsPemBundle(raw, 'staging.mcp.nession.bestnathan.top'));
    const oldHostCert = generateTlsFixture(tmp, 'old-host', 'staging.mcp.nession.bestnathan.top');
    assert.throws(() => parseTlsPemBundle(oldHostCert.crt + oldHostCert.key, tlsHostname));
    assert.throws(() => parseTlsPemBundle(a.crt + b.key, tlsHostname));
    assert.throws(() => parseTlsPemBundle(a.crt + a.key + b.key, tlsHostname));
    assert.throws(() => parseTlsPemBundle(a.crt, tlsHostname));
    assert.throws(() => parseTlsPemBundle(a.key + a.crt, tlsHostname));
    assert.throws(() => parseTlsPemBundle('unexpected\n' + raw, tlsHostname));
    assert.throws(() => parseTlsPemBundle(raw + 'unexpected\n', tlsHostname));
    assert.throws(() => parseTlsPemBundle(b.crt + b.key, tlsHostname));
    assert.throws(() => parseTlsPemBundle(soon.crt + soon.key, tlsHostname));
    assert.throws(() => parseTlsPemBundle(raw.replace('BEGIN PRIVATE KEY', 'BEGIN ENCRYPTED PRIVATE KEY'), tlsHostname));
  } finally { rmSync(tmp, {recursive: true, force: true}); }
});

test('TLS SealedSecret output must contain exactly encrypted tls.crt and tls.key', () => {
  const doc = {
    apiVersion: 'bitnami.com/v1alpha1',
    kind: 'SealedSecret',
    metadata: { name: tlsTarget.name, namespace: tlsTarget.namespace },
    spec: {
      encryptedData: {'tls.crt':'AgEncryptedCert','tls.key':'AgEncryptedKey'},
      template: {
        metadata: { name: tlsTarget.name, namespace: tlsTarget.namespace },
        type: 'kubernetes.io/tls'
      }
    }
  };
  assert.equal(validateSealed(structuredClone(doc), environment, tlsSecret).kind, 'SealedSecret');
  const badType = structuredClone(doc); badType.spec.template.type = 'Opaque';
  assert.throws(() => validateSealed(badType, environment, tlsSecret));
  const omittedType = structuredClone(doc); delete omittedType.spec.template.type;
  assert.throws(() => validateSealed(omittedType, environment, tlsSecret));
  const missingKey = structuredClone(doc); delete missingKey.spec.encryptedData['tls.key'];
  assert.throws(() => validateSealed(missingKey, environment, tlsSecret));
  const extraKey = structuredClone(doc); extraKey.spec.encryptedData.other = 'AgX';
  assert.throws(() => validateSealed(extraKey, environment, tlsSecret));
  const wrongName = structuredClone(doc); wrongName.metadata.name = 'foreign';
  assert.throws(() => validateSealed(wrongName, environment, tlsSecret));
  const plaintext = structuredClone(doc); plaintext.spec.template.data = {'tls.key':'plain'};
  assert.throws(() => validateSealed(plaintext, environment, tlsSecret));
  const broadScope = structuredClone(doc);
  broadScope.metadata.annotations = {'sealedsecrets.bitnami.com/cluster-wide':'true'};
  assert.throws(() => validateSealed(broadScope, environment, tlsSecret));
});

test('TLS Kustomize registration is repeatable, with no collision with MCP config seal', () => {
  const old = 'resources:\n  - sealed-secret.json\n  - deployment.yaml\n';
  const newYaml = addResource(old, tlsTarget.resource);
  assert.match(newYaml, /- sealed-tls\.json/);
  assert.match(newYaml, /- sealed-secret\.json/);
  assert.equal(addResource(newYaml, tlsTarget.resource), newYaml);
  assert.deepEqual(validateChangedPaths(
    [tlsTarget.resource, tlsTarget.kustomization], environment, tlsSecret),
    [tlsTarget.resource, tlsTarget.kustomization]);
  assert.throws(() => validateChangedPaths(
    ['environments/staging/mcp/sealed-secret.json'], environment, tlsSecret));
});

const inboundSecret = 'NESSION_MCP_INBOUND_TOKEN';
const inboundTarget = getTarget(environment, inboundSecret);

test('staging MCP inbound token is a dedicated strict SealedSecret target', () => {
  assert.equal(inboundTarget.name, 'nession-mcp-inbound-staging');
  assert.equal(inboundTarget.namespace, 'nession');
  assert.equal(inboundTarget.key, 'token');
  assert.equal(inboundTarget.resource, 'environments/staging/mcp/sealed-inbound.json');
  assert.equal(getTarget('production', inboundSecret).name, 'nession-mcp-inbound-production');
  assert.throws(() => getTarget('staging-01', inboundSecret));
  const doc = createPlainSecret(environment, inboundSecret, 'opaque-query-safe_token');
  assert.deepEqual(Object.keys(doc.data), ['token']);
  assert.equal(Buffer.from(doc.data.token, 'base64').toString('utf8'), 'opaque-query-safe_token');
  for (const invalid of ['', ' ', ' trailing', 'line\nbreak', '\tbad', 'bad\0null']) {
    assert.throws(() => createPlainSecret(environment, inboundSecret, invalid));
  }
});

test('staging inbound sealing rejects foreign resources and remains idempotent', () => {
  const yaml = 'resources:\n- deployment.yaml\n';
  const next = addResource(yaml, inboundTarget.resource);
  assert.match(next, /sealed-inbound\.json/);
  assert.equal(addResource(next, inboundTarget.resource), next);
  const changed = [inboundTarget.resource, inboundTarget.kustomization];
  assert.deepEqual(validateChangedPaths(changed, environment, inboundSecret), changed);
  assert.throws(() => validateChangedPaths(
    ['environments/staging/mcp/sealed-secret.json'], environment, inboundSecret));
  const sealedInbound = {
    apiVersion: 'bitnami.com/v1alpha1',
    kind: 'SealedSecret',
    metadata: {name: inboundTarget.name, namespace: inboundTarget.namespace},
    spec: {
      encryptedData: {token: 'AgEncryptedInbound'},
      template: {metadata: {name: inboundTarget.name, namespace: inboundTarget.namespace}, type: 'Opaque'}
    }
  };
  assert.equal(validateSealed(sealedInbound, environment, inboundSecret).kind, 'SealedSecret');
  const wrong = structuredClone(sealedInbound);
  wrong.spec.encryptedData['mcp.toml'] = 'AgEncryptedOldConfig';
  assert.throws(() => validateSealed(wrong, environment, inboundSecret));
});

const backendServerSecret = 'NESSION_MCP_BACKEND_SERVER_TOKEN';
const backendServerTarget = getTarget(environment, backendServerSecret);

test('backend Server credential has a distinct strict sealed target', () => {
  assert.equal(backendServerTarget.namespace, 'nession');
  assert.equal(backendServerTarget.name, 'nession-mcp-backend-server-staging');
  assert.equal(backendServerTarget.key, 'token');
  assert.equal(backendServerTarget.resource, 'environments/staging/mcp/sealed-backend-server.json');
  assert.notEqual(backendServerTarget.name, inboundTarget.name);
  assert.throws(() => getTarget('staging', 'MCP_INBOUND_TOKEN'));
  assert.throws(() => getTarget('staging', 'MCP_BACKEND_SERVER_TOKEN'));
  assert.throws(() => getTarget('production', backendServerSecret));
  const value = 'server-shared-token';
  const doc = createPlainSecret(environment, backendServerSecret, value);
  assert.deepEqual(Object.keys(doc.data), ['token']);
  assert.equal(Buffer.from(doc.data.token, 'base64').toString('utf8'), value);
  for (const invalid of ['', ' ', ' trailing', 'line\nbreak', 'bad\0null']) {
    assert.throws(() => createPlainSecret(environment, backendServerSecret, invalid));
  }
});

test('backend server sealing is strict, separately published and idempotent', () => {
  const yaml = 'resources:\n- deployment.yaml\n';
  const next = addResource(yaml, backendServerTarget.resource);
  assert.match(next, /sealed-backend-server\.json/);
  assert.equal(addResource(next, backendServerTarget.resource), next);
  const allowed = [backendServerTarget.resource, backendServerTarget.kustomization];
  assert.deepEqual(validateChangedPaths(allowed, environment, backendServerSecret), allowed);
  assert.throws(() => validateChangedPaths([inboundTarget.resource], environment, backendServerSecret));
  const sealedServer = {
    apiVersion: 'bitnami.com/v1alpha1',
    kind: 'SealedSecret',
    metadata: {name: backendServerTarget.name, namespace: backendServerTarget.namespace},
    spec: {
      encryptedData: {token: 'AgEncryptedBackendServer'},
      template: {metadata: {name: backendServerTarget.name, namespace: backendServerTarget.namespace}, type: 'Opaque'}
    }
  };
  assert.equal(validateSealed(sealedServer, environment, backendServerSecret).kind, 'SealedSecret');
  const unexpected = structuredClone(sealedServer);
  unexpected.spec.encryptedData['auth-token'] = 'AgOther';
  assert.throws(() => validateSealed(unexpected, environment, backendServerSecret));
});

test('environment dispatch registers the COMPLETE fixed required Secret set', () => {
  assert.deepEqual(getRequiredSecrets('staging'), [
    'NESSION_MCP_INBOUND_TOKEN', 'NESSION_MCP_BACKEND_SERVER_TOKEN'
  ]);
  for (const other of ['', 'preprod', 'staging-01', '../staging']) {
    assert.throws(() => getRequiredSecrets(other));
  }
  assert.ok(!getRequiredSecrets('staging').includes('MCP_CONFIG_TOML'));
  assert.ok(!getRequiredSecrets('staging').includes('MCP_TLS_PEM_BUNDLE'));
});

test('all environment credentials are required and checked BEFORE any seal', () => {
  const good = {
    NESSION_MCP_INBOUND_TOKEN: 'client-random-token',
    NESSION_MCP_BACKEND_SERVER_TOKEN: 'server-matching-token'
  };
  const all = prepareRequiredSecrets('staging', good);
  assert.deepEqual(all.map(x => x.name), getRequiredSecrets('staging'));
  assert.deepEqual(all.map(x => Object.keys(x.document.data)), [['token'], ['token']]);
  assert.throws(() => prepareRequiredSecrets('staging', {}), /NESSION_MCP_INBOUND_TOKEN/);
  assert.throws(() => prepareRequiredSecrets('staging', {
    NESSION_MCP_INBOUND_TOKEN: good.NESSION_MCP_INBOUND_TOKEN
  }), /NESSION_MCP_BACKEND_SERVER_TOKEN/);
  assert.throws(() => prepareRequiredSecrets('staging', {
    NESSION_MCP_BACKEND_SERVER_TOKEN: good.NESSION_MCP_BACKEND_SERVER_TOKEN
  }), /NESSION_MCP_INBOUND_TOKEN/);
  for (const name of getRequiredSecrets('staging')) {
    for (const bad of ['', ' ', 'newline\nvalue', 'prefix ']) {
      assert.throws(() => prepareRequiredSecrets('staging', {...good, [name]: bad}),
        new RegExp(name));
    }
  }
  assert.throws(() => prepareRequiredSecrets('staging', {
    ...good, NESSION_MCP_BACKEND_SERVER_TOKEN: good.NESSION_MCP_INBOUND_TOKEN
  }), /must be distinct/);
  // No Error should contain the raw credential value.
  try {
    prepareRequiredSecrets('staging', {...good, NESSION_MCP_BACKEND_SERVER_TOKEN: ''});
    assert.fail('empty backend credential accepted');
  } catch (e) {
    assert.doesNotMatch(e.message, /client-random-token|server-matching-token/);
  }
});

test('required encrypted GitOps resources are one bounded atomic file set', () => {
  const registered = getRequiredSecrets('staging');
  const targets = registered.map(name => getTarget('staging', name));
  const full = [targets[0].resource, targets[1].resource, targets[0].kustomization];
  assert.deepEqual(validateChangedPathsForRequired(full, 'staging'), full);
  assert.deepEqual(validateChangedPathsForRequired(full.slice(0, 2), 'staging'), full.slice(0, 2));
  assert.throws(() => validateChangedPathsForRequired([targets[0].resource], 'staging'));
  assert.throws(() => validateChangedPathsForRequired([targets[1].resource], 'staging'));
  assert.throws(() => validateChangedPathsForRequired(
    [...full, 'environments/staging/mcp/sealed-tls.json'], 'staging'));
  assert.throws(() => validateChangedPathsForRequired(
    [...full, 'environments/staging/mcp/sealed-secret.json'], 'staging'));
  const initial = 'resources:\n  - deployment.yaml\n';
  const next = addRequiredResources(initial, 'staging');
  for (const t of targets) assert.match(next, new RegExp(t.resource.split('/').at(-1).replaceAll('.', '\\.')));
  assert.equal(addRequiredResources(next, 'staging'), next);
});

test('staging batch aborts before touching GitOps if ANY sealed output is absent or malformed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nession-seal-batch-'));
  const work = path.join(root, 'work');
  const overlay = path.join(root, 'environments/staging/mcp');
  const kustomization = path.join(overlay, 'kustomization.yaml');
  const names = getRequiredSecrets('staging');
  const document = name => {
    const t = getTarget('staging', name);
    return {
      apiVersion: 'bitnami.com/v1alpha1',
      kind: 'SealedSecret',
      metadata: {name: t.name, namespace: t.namespace},
      spec: {
        encryptedData: {token: 'AgValidPlaceholder'},
        template: {metadata: {name: t.name, namespace: t.namespace}, type: 'Opaque'}
      }
    };
  };
  try {
    mkdirSync(path.join(root, '.git'));
    mkdirSync(overlay, {recursive: true});
    mkdirSync(work);
    const before = 'resources:\n  - deployment.yaml\n';
    writeFileSync(kustomization, before);
    const location = name => path.join(work, name + '.sealed.json');
    writeFileSync(location(names[0]), JSON.stringify(document(names[0])));
    assert.throws(() => stageRequired(root, 'staging', work), /missing or malformed/);
    assert.equal(readFileSync(kustomization, 'utf8'), before);
    assert.ok(!existsSync(path.join(root, getTarget('staging', names[0]).resource)));

    writeFileSync(location(names[1]), '{"broken"');
    assert.throws(() => stageRequired(root, 'staging', work), /missing or malformed/);
    assert.ok(!existsSync(path.join(root, getTarget('staging', names[0]).resource)));

    writeFileSync(location(names[1]), JSON.stringify({...document(names[1]),
      metadata: {name: 'wrong', namespace: 'nession'}}));
    assert.throws(() => stageRequired(root, 'staging', work), /Kubernetes identity mismatch/);
    assert.ok(!existsSync(path.join(root, getTarget('staging', names[0]).resource)));

    writeFileSync(location(names[1]), JSON.stringify(document(names[1])));
    stageRequired(root, 'staging', work);
    const enrolled = readFileSync(kustomization, 'utf8');
    for (const name of names) {
      const t = getTarget('staging', name);
      assert.match(enrolled, new RegExp(t.resource.split('/').at(-1).replaceAll('.', '\\.')));
      assert.equal(JSON.parse(readFileSync(path.join(root, t.resource), 'utf8')).metadata.name, t.name);
    }
    stageRequired(root, 'staging', work);
    assert.equal(readFileSync(kustomization, 'utf8'), enrolled);
  } finally { rmSync(root, {recursive: true, force: true}); }
});


test('production seals only its own inbound credential and never staging or backend resources', () => {
  assert.deepEqual(getRequiredSecrets('production'), [inboundSecret]);
  const target = getTarget('production', inboundSecret);
  assert.equal(target.resource, 'environments/production/mcp/sealed-inbound.json');
  assert.equal(target.kustomization, 'environments/production/mcp/kustomization.yaml');
  assert.deepEqual(prepareRequiredSecrets('production', {[inboundSecret]: 'pilot-inbound-token'}).map(x => x.name), [inboundSecret]);
  assert.throws(() => prepareRequiredSecrets('production', {}));
  assert.throws(() => getTarget('production', backendServerSecret));
  assert.throws(() => validateChangedPathsForRequired([inboundTarget.resource], 'production'));
  assert.deepEqual(validateChangedPathsForRequired([target.resource, target.kustomization], 'production'), [target.resource, target.kustomization]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { getSite } from './configure-cloudflare-site.mjs';
import { issueOriginCa, validateIssuedOriginCertificate } from './issue-cloudflare-origin-ca.mjs';

const hostname = 'staging-mcp-nession.bestnathan.top';
const zoneId = 'a'.repeat(32);
const token = 'mock-cloudflare-token-not-real-credential';
const originIp = '8.8.4.4';
const owned = 'managed-by:nession:site=staging-mcp:issue=3963';

function openssl(...args) {
  execFileSync('openssl', args, { stdio: 'ignore', timeout: 30000 });
}
function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-origin-test-'));
  fs.chmodSync(root, 0o700);
  const caKey = path.join(root, 'ca.key');
  const caCrt = path.join(root, 'ca.crt');
  const leafKey = path.join(root, 'leaf.key');
  const csrPath = path.join(root, 'leaf.csr');
  const certPath = path.join(root, 'leaf.crt');
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', caKey, '-out', caCrt, '-days', '30', '-subj', '/CN=Test Origin CA');
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', leafKey, '-out', csrPath, '-subj', '/CN=' + hostname,
    '-addext', 'subjectAltName=DNS:' + hostname);
  function sign(san = hostname, selfSigned = false) {
    if (selfSigned) {
      openssl('req', '-x509', '-new', '-key', leafKey,
        '-out', certPath, '-days', '30', '-subj', '/CN=' + san,
        '-addext', 'subjectAltName=DNS:' + san);
    } else {
      const ext = path.join(root, 'extensions.txt');
      fs.writeFileSync(ext, 'subjectAltName=DNS:' + san + '\n');
      openssl('x509', '-req', '-in', csrPath, '-CA', caCrt,
        '-CAkey', caKey, '-CAcreateserial', '-out', certPath,
        '-days', '30', '-sha256', '-extfile', ext);
    }
    return fs.readFileSync(certPath, 'utf8');
  }
  return {
    root, caCertificate: fs.readFileSync(caCrt, 'utf8'),
    privateKey: fs.readFileSync(leafKey, 'utf8'),
    csr: fs.readFileSync(csrPath, 'utf8'), sign,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function fakeApi(fixture, {
  dnsContent = originIp, dnsOwner = owned,
  zone = 'bestnathan.top',
  certHostname = hostname,
  wrongCsr = false,
  selfSigned = false,
  rejected = false,
  responseType = 'origin-rsa'
} = {}) {
  const calls = [];
  const ok = result => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const fetchImpl = async (url, request) => {
    const u = new URL(url);
    const { method } = request;
    calls.push({ method, pathname: u.pathname });
    assert.equal(request.headers.Authorization, 'Bearer ' + token);
    if (method === 'GET' && u.pathname === '/client/v4/zones/' + zoneId) {
      return ok({ id: zoneId, name: zone, status: 'active' });
    }
    if (method === 'GET' && u.pathname === '/client/v4/ips') {
      return ok({ ipv4_cidrs: ['104.16.0.0/13', '172.64.0.0/13'] });
    }
    if (method === 'GET' && u.pathname === '/client/v4/zones/' + zoneId + '/dns_records') {
      return ok([{
        id: 'b'.repeat(32), name: hostname, type: 'A',
        content: dnsContent, proxied: true, ttl: 1, comment: dnsOwner
      }]);
    }
    if (method === 'POST' && u.pathname === '/client/v4/certificates') {
      if (rejected) return new Response('{}', { status: 403 });
      const body = JSON.parse(request.body);
      assert.deepEqual(body.hostnames, [hostname]);
      assert.equal(body.request_type, 'origin-rsa');
      assert.equal(body.requested_validity, 365);
      assert.equal(body.csr, fixture.csr);
      return ok({
        certificate: fixture.sign(certHostname, selfSigned),
        hostnames: [certHostname],
        csr: wrongCsr ? 'changed CSR' : body.csr,
        request_type: responseType
      });
    }
    throw new Error('Unexpected provider API path');
  };
  return { calls, fetchImpl };
}

function args(fixture, fetchImpl, extra = {}) {
  return {
    mode: 'issue-tls', siteId: 'staging-mcp',
    environment: 'staging', apiToken: token, zoneId,
    originIpv4: originIp, sealingCertificate: fixture.caCertificate,
    runnerTemp: fixture.root, fetchImpl,
    keyGenerator: async () => ({
      csr: fixture.csr, privateKey: fixture.privateKey
    }), ...extra
  };
}

test('Cloudflare CA cert is validated, same token used, private material stays only in runner scratch', async () => {
  const f = createFixture();
  try {
    const api = fakeApi(f);
    const messages = [];
    const result = await issueOriginCa(args(f, api.fetchImpl, {
      logger: msg => messages.push(msg)
    }));
    assert.equal(result.secretName, 'nession-mcp-staging-tls');
    assert.equal(result.hostname, hostname);
    assert.deepEqual(api.calls.map(x => x.method), ['GET', 'GET', 'GET', 'POST']);
    const folder = path.join(f.root, 'nession-seal');
    const cert = fs.readFileSync(path.join(folder, 'cert.pem'), 'utf8');
    assert.equal(cert, f.caCertificate);
    const plainFile = path.join(folder, 'secret.json');
    assert.equal(fs.statSync(plainFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(folder, 'cert.pem')).mode & 0o777, 0o600);
    const secret = JSON.parse(fs.readFileSync(plainFile, 'utf8'));
    assert.equal(secret.type, 'kubernetes.io/tls');
    assert.deepEqual(Object.keys(secret.data).sort(), ['tls.crt', 'tls.key']);
    const key = Buffer.from(secret.data['tls.key'], 'base64').toString('utf8');
    assert.equal(key.trim(), f.privateKey.trim());
    const leaf = new X509Certificate(Buffer.from(secret.data['tls.crt'], 'base64'));
    assert.equal(leaf.checkHost(hostname, { subject: 'never' }), hostname);
    assert.ok(!messages.join('').includes(f.privateKey));
    assert.ok(!messages.join('').includes(token));
  } finally {
    f.cleanup();
  }
});

test('bad operation, site, credentials or zone fail before Origin CA mutation', async () => {
  const f = createFixture();
  try {
    for (const overrides of [
      { mode: 'apply' }, { siteId: 'not-reviewed' },
      { environment: 'production' }, { apiToken: '' },
      { zoneId: 'invalid' }, { originIpv4: '127.0.0.1' },
      { sealingCertificate: '' }
    ]) {
      const api = fakeApi(f);
      await assert.rejects(issueOriginCa(args(f, api.fetchImpl, overrides)));
      assert.equal(api.calls.some(x => x.method === 'POST'), false);
    }
  } finally { f.cleanup(); }
});

test('DNS mismatch, wrong ownership and wrong zone block issuance', async () => {
  const f = createFixture();
  try {
    for (const config of [
      { dnsContent: '1.1.1.1' }, { dnsOwner: 'someone-else' },
      { zone: 'wrong-zone.example' }
    ]) {
      const api = fakeApi(f, config);
      await assert.rejects(issueOriginCa(args(f, api.fetchImpl)));
      assert.equal(api.calls.some(x => x.method === 'POST'), false);
    }
  } finally { f.cleanup(); }
});

test('untrusted, wrong hostname, wrong CSR and malformed provider response fail closed', async () => {
  const configs = [
    { certHostname: 'other.example.com' },
    { selfSigned: true },
    { wrongCsr: true },
    { responseType: 'origin-ecc' },
    { rejected: true }
  ];
  for (const opts of configs) {
    const f = createFixture();
    try {
      const api = fakeApi(f, opts);
      await assert.rejects(issueOriginCa(args(f, api.fetchImpl)));
      assert.equal(fs.existsSync(path.join(f.root, 'nession-seal')), false);
    } finally { f.cleanup(); }
  }
});

test('certificate-key mismatch or extra SAN scope rejected', () => {
  const f = createFixture();
  const g = createFixture();
  try {
    assert.throws(() => validateIssuedOriginCertificate({
      site: getSite('staging-mcp'), certificate: f.sign(),
      privateKey: g.privateKey, hostnames: [hostname], csr: f.csr
    }));
    assert.throws(() => validateIssuedOriginCertificate({
      site: getSite('staging-mcp'), certificate: f.sign(),
      privateKey: f.privateKey, hostnames: [hostname, '*.bestnathan.top'], csr: f.csr
    }));
  } finally { f.cleanup(); g.cleanup(); }
});

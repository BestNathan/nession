#!/usr/bin/env node
// One-shot Cloudflare Origin CA issuance for the reviewed staging MCP site.
// The key stays in this approved GitHub Runner and only a strict kubeseal
// ciphertext may be published to GitOps (#3992).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configureSite, getSite, validateInputs } from './configure-cloudflare-site.mjs';
import { createPlainSecret, getTarget, parseTlsPemBundle, validatePublicCert } from './seal-gitops-secret.mjs';

const CERTIFICATE_ENDPOINT = 'https://api.cloudflare.com/client/v4/certificates';
const SECRET_TARGET = 'MCP_TLS_PEM_BUNDLE';

export function validateIssuedOriginCertificate({ site, certificate, privateKey, hostnames, csr }) {
  if (!Array.isArray(hostnames) || hostnames.length !== 1 || hostnames[0] !== site.hostname) {
    throw new Error('Origin CA returned unexpected certificate hostname scope');
  }
  if (typeof csr !== 'string' || !csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----')) {
    throw new Error('Origin CA request CSR is missing');
  }
  const parsed = parseTlsPemBundle(certificate.trim() + '\n' + privateKey.trim() + '\n', site.hostname);
  const leaf = new X509Certificate(parsed.certificateChain);
  if (leaf.checkIssued(leaf) && leaf.verify(leaf.publicKey)) {
    throw new Error('Cloudflare Origin CA response must not be a self-signed leaf');
  }
  return { certificateChain: parsed.certificateChain, privateKey: parsed.privateKey };
}

function generateKeyAndCsr(work, hostname) {
  const keyFile = path.join(work, 'origin.key');
  const csrFile = path.join(work, 'origin.csr');
  try {
    execFileSync('openssl', [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyFile, '-out', csrFile,
      '-subj', '/CN=' + hostname,
      '-addext', 'subjectAltName=DNS:' + hostname
    ], { stdio: 'ignore', timeout: 30000 });
    fs.chmodSync(keyFile, 0o600);
    return {
      privateKey: fs.readFileSync(keyFile, 'utf8'),
      csr: fs.readFileSync(csrFile, 'utf8')
    };
  } catch {
    throw new Error('Could not generate local Origin CA key and CSR');
  }
}

export async function issueOriginCa({
  mode, siteId, environment, apiToken, zoneId, originIpv4,
  sealingCertificate, runnerTemp,
  fetchImpl = globalThis.fetch,
  keyGenerator = generateKeyAndCsr,
  logger = () => {}
}) {
  if (mode !== 'issue-tls') throw new Error('Only explicit issue-tls may create an Origin CA certificate');
  const site = getSite(siteId);
  if (environment !== site.environment || siteId !== 'staging-mcp') {
    throw new Error('Origin CA site/environment pairing not authorized');
  }
  validateInputs({ apiToken, zoneId, originIpv4 });
  getTarget(environment, SECRET_TARGET);
  const controllerCert = validatePublicCert(sealingCertificate);

  // DNS plan is READ-ONLY, must match the actual registered origin, and must
  // already be owned by this site. Never mint an Origin CA cert for a
  // mismatched/unmanaged DNS record.
  const dns = await configureSite({
    mode: 'plan', siteId, environment, apiToken, zoneId, originIpv4, fetchImpl
  });
  if (dns.kind !== 'noop' || dns.owned !== true) {
    throw new Error('Origin CA issuance requires existing, matching Nession-owned proxied DNS');
  }

  if (typeof runnerTemp !== 'string' || !path.isAbsolute(runnerTemp) ||
      !fs.existsSync(runnerTemp) || !fs.statSync(runnerTemp).isDirectory()) {
    throw new Error('RUNNER_TEMP is required for ephemeral credential handling');
  }
  const keyWork = fs.mkdtempSync(path.join(runnerTemp, 'nession-origin-ca-'));
  fs.chmodSync(keyWork, 0o700);
  const sealWork = path.join(runnerTemp, 'nession-seal');
  try {
    if (fs.existsSync(sealWork)) throw new Error('Existing SealedSecret scratch directory refused');
    const { csr, privateKey } = await keyGenerator(keyWork, site.hostname);
    if (typeof csr !== 'string' || !csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----') ||
        typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) {
      throw new Error('Locally generated Origin CA CSR/key is invalid');
    }
    let response;
    try {
      response = await fetchImpl(CERTIFICATE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          csr,
          hostnames: [site.hostname],
          request_type: 'origin-rsa',
          requested_validity: 365
        }),
        signal: AbortSignal.timeout(20000)
      });
    } catch {
      throw new Error('Cloudflare Origin CA connection failed');
    }
    if (!response?.ok) {
      throw new Error('Cloudflare Origin CA rejected issuance (HTTP ' + (response?.status ?? 'unknown') + ')');
    }
    // Never log Cloudflare API response fields or an OpenSSL error dump.
    const doc = await response.json().catch(() => null);
    if (doc?.success !== true || typeof doc.result?.certificate !== 'string' ||
        doc.result?.request_type !== 'origin-rsa' ||
        !Array.isArray(doc.result?.hostnames) ||
        doc.result?.csr?.trim() !== csr.trim()) {
      throw new Error('Cloudflare Origin CA response failed exact CSR and scope validation');
    }
    const pem = validateIssuedOriginCertificate({
      site,
      certificate: doc.result.certificate,
      privateKey,
      hostnames: doc.result.hostnames,
      csr
    });
    const sealedSource = createPlainSecret(
      environment, SECRET_TARGET, pem.certificateChain + pem.privateKey
    );
    fs.mkdirSync(sealWork, { mode: 0o700 });
    fs.writeFileSync(path.join(sealWork, 'cert.pem'), controllerCert, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(sealWork, 'secret.json'), JSON.stringify(sealedSource),
      { flag: 'wx', mode: 0o600 });
    logger('site=' + siteId + ' TLS identity and private-key matching validated; local sealing input ready');
    return { hostname: site.hostname, secretName: sealedSource.metadata.name };
  } catch (error) {
    // A failed operation must not leave a plaintext Secret staged for upload.
    fs.rmSync(sealWork, { recursive: true, force: true });
    // Avoid printing exceptions containing a CSR, PEM or request payload.
    throw new Error('Origin CA issuance/sealing preparation failed: ' +
      (error instanceof Error ? error.message : 'unexpected failure'));
  } finally {
    fs.rmSync(keyWork, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  issueOriginCa({
    mode: process.argv[2],
    siteId: process.argv[3],
    environment: process.env.TARGET_ENVIRONMENT,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    originIpv4: process.env.CLOUDFLARE_ORIGIN_IPV4,
    sealingCertificate: process.env.SEALED_SECRETS_CERT_PEM,
    runnerTemp: process.env.RUNNER_TEMP,
    logger: line => console.log(line)
  }).catch(() => {
    // Intentionally don't echo untrusted provider/OpenSSL error strings at this
    // private-key boundary; detailed safe errors are testable in unit tests.
    console.error('Origin CA issuance failed; no plaintext certificate material was published');
    process.exitCode = 1;
  });
}

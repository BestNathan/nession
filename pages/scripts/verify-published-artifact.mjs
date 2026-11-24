// Anonymous HTTPS readback for the trusted Pages artifact. The expected
// manifest digest comes from the trusted build, never from the deployed
// website. Every compiled file in the closure is compared byte-for-byte
// during a bounded retry window; a matching main SHA is not sufficient.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {verifyManifestShape, MANIFEST_FILE, MAX_FILE_BYTES} from './artifact-manifest.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;

const sha256 = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

export async function fetchBoundedBytes(fetchImpl, url, limit = MAX_FILE_BYTES) {
  const response = await fetchImpl(url, {
    headers: {'cache-control': 'no-cache'},
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error('Response exceeds bounded Pages artifact size: ' + url);
  return bytes;
}

export async function verifyPublishedArtifact({
  base,
  expectedManifestSha,
  revision,
  fetchImpl = fetch,
  attempts = 18,
  delayMs = 5000,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  if (!SHA256.test(expectedManifestSha || '')) throw new Error('Invalid expected artifact manifest digest');
  if (!SHA.test(revision || '')) throw new Error('Invalid expected main revision');
  const origin = base.replace(/\/$/, '');
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const manifestUrl = origin + '/' + MANIFEST_FILE + '?revision=' + revision;
      const manifestBytes = await fetchBoundedBytes(fetchImpl, manifestUrl, 4 * 1024 * 1024);
      if (sha256(manifestBytes) !== expectedManifestSha) {
        throw new Error('Published artifact manifest digest differs from trusted build output');
      }
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      verifyManifestShape(manifest);
      for (const file of manifest.files) {
        const bytes = await fetchBoundedBytes(fetchImpl, origin + '/' + file.path + '?revision=' + revision, file.bytes);
        if (bytes.length !== file.bytes) throw new Error('Published file size mismatch: ' + file.path);
        if (sha256(bytes) !== file.sha256) throw new Error('Published file digest mismatch: ' + file.path);
      }
      return {
        manifest,
        files: manifest.files.length,
        closure_sha256: manifest.closure_sha256,
        manifest_sha256: expectedManifestSha,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(
    'Public Pages artifact did not serve the exact trusted closure during bounded readback: ' +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error('Unexpected argument: ' + argument);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('Missing value for ' + argument);
    values[key] = value;
    index += 1;
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArguments(process.argv.slice(2));
  const result = await verifyPublishedArtifact({
    base: args.base,
    expectedManifestSha: args['manifest-sha'],
    revision: args['main-sha'],
    attempts: args.attempts ? Number(args.attempts) : undefined,
  });
  console.log(
    'Published Pages artifact verified: ' +
      JSON.stringify({
        files: result.files,
        closure_sha256: result.closure_sha256,
        manifest_sha256: result.manifest_sha256,
      }),
  );
}

export {sha256};

// Trusted build-generated artifact manifest. The deployed website never
// supplies the expected digest: this manifest originates in the trusted build,
// enumerates both HTML entrypoints and the complete local JS/CSS/static closure
// (including dynamic imports and stable public assets), and is verified against
// anonymous HTTPS bytes by the publisher readback.
import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, posix, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const ENTRYPOINTS = Object.freeze(['index.html', 'workflows.html']);
export const MANIFEST_FILE = 'artifact-manifest.json';
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXTENSION = /\.(?:html|js|mjs|css|svg|woff2?)$/;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function portable(path) {
  return path.split(sep).join('/');
}

export function normalizeReference(fromFile, rawReference) {
  if (typeof rawReference !== 'string' || !rawReference) return null;
  const reference = rawReference.trim();
  if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) {
    throw new Error('External asset reference is not permitted: ' + reference + ' in ' + fromFile);
  }
  if (reference.startsWith('/') || reference.includes('\\') || /\0|\r|\n/.test(reference)) {
    throw new Error('Absolute or unsafe asset reference: ' + reference + ' in ' + fromFile);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(reference.split('#')[0].split('?')[0]);
  } catch {
    throw new Error('Malformed asset reference: ' + reference + ' in ' + fromFile);
  }
  const normalized = posix.normalize(posix.join(posix.dirname(fromFile), decoded));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error('Asset reference escapes the Pages artifact: ' + reference + ' in ' + fromFile);
  }
  if (!ALLOWED_EXTENSION.test(normalized)) {
    throw new Error('Unexpected asset type in Pages closure: ' + normalized);
  }
  return normalized;
}

function htmlReferences(content) {
  const references = [];
  for (const tag of content.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const name = tag[1].toLowerCase();
    const attributes = new Map();
    for (const attribute of tag[2].matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
      attributes.set(attribute[1].toLowerCase(), attribute[2]);
    }
    if (name === 'script') {
      if (attributes.has('src')) references.push(attributes.get('src'));
      continue;
    }
    const rel = (attributes.get('rel') || '').toLowerCase().split(/\s+/);
    if (rel.some((value) => ['stylesheet', 'icon', 'modulepreload', 'preload'].includes(value)) && attributes.has('href')) {
      references.push(attributes.get('href'));
    }
  }
  for (const attribute of content.matchAll(/<(?:source|img)\b[^>]*\b(?:src|srcset)\s*=\s*"([^"]+)"/gi)) {
    references.push(attribute[1].split(',')[0].trim().split(/\s+/)[0]);
  }
  return references;
}

function javascriptReferences(content) {
  const references = [];
  for (const match of content.matchAll(/\bfrom\s*["']([^"']+)["']/g)) references.push(match[1]);
  for (const match of content.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) references.push(match[1]);
  for (const match of content.matchAll(/\bimport\s*["']([^"']+)["']/g)) references.push(match[1]);
  for (const match of content.matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
    references.push(match[1]);
  }
  return references;
}

function cssReferences(content) {
  // The existing public stylesheet intentionally imports the Google Fonts
  // stylesheet at runtime. It is not a published artifact file, so it is not
  // part of the local closure; every local url()/import must be verified.
  const references = [];
  const accept = (reference) => {
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) return;
    references.push(reference);
  };
  for (const match of content.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) accept(match[2]);
  for (const match of content.matchAll(/@import\s+(["'])([^"']+)\1/g)) accept(match[2]);
  return references;
}

async function assertRegularFile(rootDir, path) {
  const absolute = join(rootDir, path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Closure entry is not a regular file: ' + path);
  if (stat.size > MAX_FILE_BYTES) throw new Error('Closure file exceeds size budget: ' + path);
  return stat.size;
}

export async function computeArtifactManifest(distDir) {
  const root = resolve(distDir);
  const pending = [...ENTRYPOINTS];
  const seen = new Map();
  let totalBytes = 0;
  while (pending.length) {
    const path = pending.shift();
    if (!path || seen.has(path)) continue;
    if (seen.size >= MAX_FILES) throw new Error('Pages closure exceeds file budget');
    const size = await assertRegularFile(root, path);
    const bytes = await readFile(join(root, path));
    seen.set(path, {sha256: sha256(bytes), bytes: size});
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Pages closure exceeds size budget');
    const content = bytes.toString('utf8');
    const references = path.endsWith('.html')
      ? htmlReferences(content)
      : path.endsWith('.js') || path.endsWith('.mjs')
        ? javascriptReferences(content)
        : path.endsWith('.css')
          ? cssReferences(content)
          : [];
    for (const reference of references) {
      const normalized = normalizeReference(path, reference);
      if (normalized && !seen.has(normalized)) pending.push(normalized);
    }
  }
  for (const entrypoint of ENTRYPOINTS) {
    if (!seen.has(entrypoint)) throw new Error('Pages closure is missing entrypoint ' + entrypoint);
  }
  // No unknown published artifact may ride along outside the verified closure.
  const published = await listPublishedFiles(root);
  for (const file of published) {
    if (file === MANIFEST_FILE) continue;
    if (seen.has(file)) continue;
    throw new Error('Unknown Pages artifact outside the verified closure: ' + file);
  }
  const files = [...seen.entries()]
    .map(([path, value]) => ({path, sha256: value.sha256, bytes: value.bytes}))
    .sort((a, b) => a.path.localeCompare(b.path));
  const closure_sha256 = sha256(files.map((file) => file.path + '\0' + file.sha256).join('\n'));
  const manifest = {
    schema_version: 1,
    entrypoints: [...ENTRYPOINTS],
    files,
    closure_sha256,
  };
  return {manifest, json: JSON.stringify(manifest, null, 2) + '\n'};
}

async function listPublishedFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = portable(relative(root, absolute));
      if (entry.isSymbolicLink()) throw new Error('Symlink is not permitted in Pages artifact: ' + rel);
      if (entry.isDirectory()) {
        // Data JSON, prototypes and the artifact manifest have their own
        // exact-byte publication contracts.
        if (rel === 'data' || rel === 'prototypes') continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error('Unsupported Pages artifact entry: ' + rel);
      files.push(rel);
    }
  }
  await walk(root);
  return files.sort();
}

export function verifyManifestShape(manifest) {
  if (manifest?.schema_version !== 1 || !SHA256.test(manifest.closure_sha256 || '')) {
    throw new Error('Invalid Pages artifact manifest schema');
  }
  if (
    !Array.isArray(manifest.entrypoints) ||
    JSON.stringify(manifest.entrypoints) !== JSON.stringify(ENTRYPOINTS)
  ) {
    throw new Error('Invalid Pages artifact manifest entrypoints');
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) {
    throw new Error('Invalid Pages artifact manifest file list');
  }
  const seen = new Set();
  let total = 0;
  for (const file of manifest.files) {
    const safe = typeof file?.path === 'string' ? normalizeManifestPath(file.path) : null;
    if (!safe || safe !== file.path) throw new Error('Unsafe Pages artifact manifest path: ' + file?.path);
    if (seen.has(safe)) throw new Error('Duplicate Pages artifact manifest path: ' + safe);
    seen.add(safe);
    if (!SHA256.test(file.sha256 || '')) throw new Error('Invalid Pages artifact digest: ' + safe);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) {
      throw new Error('Invalid Pages artifact size: ' + safe);
    }
    total += file.bytes;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error('Pages artifact manifest exceeds size budget');
  for (const entrypoint of ENTRYPOINTS) {
    if (!seen.has(entrypoint)) throw new Error('Pages artifact manifest is missing ' + entrypoint);
  }
  const closure = sha256(manifest.files.map((file) => file.path + '\0' + file.sha256).join('\n'));
  if (closure !== manifest.closure_sha256) throw new Error('Pages artifact closure digest mismatch');
  return manifest;
}

function normalizeManifestPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || /\0|\r|\n/.test(path)) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const normalized = posix.normalize(decoded);
  if (normalized !== decoded || normalized === '..' || normalized.startsWith('../')) return null;
  if (!ALLOWED_EXTENSION.test(normalized)) return null;
  return normalized;
}

export async function verifyArtifactFiles(distDir, manifest) {
  const root = resolve(distDir);
  const verified = [];
  for (const file of manifest.files) {
    const absolute = join(root, file.path);
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) {
      throw new Error('Pages artifact file size/type mismatch: ' + file.path);
    }
    const bytes = await readFile(absolute);
    if (sha256(bytes) !== file.sha256) throw new Error('Pages artifact digest mismatch: ' + file.path);
    verified.push(file.path);
  }
  return verified;
}

export async function writeArtifactManifest(distDir) {
  const {manifest, json} = await computeArtifactManifest(distDir);
  verifyManifestShape(manifest);
  await verifyArtifactFiles(distDir, manifest);
  await writeFile(join(resolve(distDir), MANIFEST_FILE), json, {mode: 0o644});
  return {manifest, json, sha256: sha256(Buffer.from(json, 'utf8'))};
}

export async function readAndVerifyManifest(distDir) {
  const manifest = JSON.parse(await readFile(join(resolve(distDir), MANIFEST_FILE), 'utf8'));
  verifyManifestShape(manifest);
  await verifyArtifactFiles(distDir, manifest);
  return manifest;
}

export {sha256, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || 'write';
  const root = process.argv[3];
  if (command === 'write') {
    if (!root) throw new Error('usage: artifact-manifest.mjs write|verify <distDir>');
    const result = await writeArtifactManifest(root);
    console.log('Pages artifact manifest written:', join(resolve(root), MANIFEST_FILE));
    console.log(
      JSON.stringify({
        entrypoints: result.manifest.entrypoints,
        files: result.manifest.files.length,
        closure_sha256: result.manifest.closure_sha256,
        manifest_sha256: result.sha256,
      }),
    );
  } else if (command === 'verify') {
    if (!root) throw new Error('usage: artifact-manifest.mjs write|verify <distDir>');
    const manifest = await readAndVerifyManifest(root);
    console.log('Pages artifact manifest verified:', manifest.files.length, 'files', manifest.closure_sha256);
  } else {
    throw new Error('usage: artifact-manifest.mjs write|verify <distDir>');
  }
}

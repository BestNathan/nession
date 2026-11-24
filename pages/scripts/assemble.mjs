// Collision-checked assembly of the three independent Pages inputs. This
// boundary only copies validated files: the credential-free Vite UI build and
// the trusted Node/Rust data projection. It never rewrites projection data,
// and Vite's own emptyOutDir can only ever touch its isolated input directory.
import {copyFile, lstat, mkdir, readdir, readFile, rm} from 'node:fs/promises';
import {dirname, join, posix, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const DATA_FILES = ['data/site.json', 'data/workflows.json', 'data/knowledge.json', 'data/documents.json', 'data/mcp.json'];
const MAX_UI_FILES = 64;
const MAX_DATA_FILES = 5;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

function portable(path) {
  return path.split(sep).join('/');
}

async function listFiles(root, options = {}) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = portable(relative(root, absolute));
      if (entry.isSymbolicLink()) throw new Error('Symlink is not permitted in Pages input: ' + rel);
      if (entry.isDirectory()) {
        if (options.skipHidden && entry.name.startsWith('.')) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error('Unsupported Pages input entry: ' + rel);
      files.push(rel);
    }
  }
  await walk(root);
  return files;
}

function safeRelative(path) {
  if (typeof path !== 'string' || !path || /[\0\r\n\\]/.test(path)) return null;
  if (path.startsWith('/') || /^[a-z]+:/i.test(path)) return null;
  const decoded = decodeURIComponent(path);
  const normalized = posix.normalize(decoded);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
  if (normalized !== decoded) return null;
  return normalized;
}

async function validateUi(uiDir) {
  const all = await listFiles(uiDir, {skipHidden: true});
  const files = all.filter((file) => !file.startsWith('.vite/'));
  if (files.length > MAX_UI_FILES) throw new Error('Pages UI artifact exceeds file budget');
  for (const file of files) {
    const safe = safeRelative(file);
    if (!safe || safe !== file) throw new Error('Non-normalized Pages UI path: ' + file);
    // Asset-typed files must be part of the build closure verified later by
    // artifact-manifest.mjs; anything with an unexpected type is rejected here.
    // The three stable public paths and both HTML entrypoints are mandatory.
    if (!/\.(?:html|js|mjs|css|svg|png|jpe?g|webp|woff2?)$/.test(file)) {
      throw new Error('Unknown Pages UI artifact: ' + file);
    }
    const stat = await lstat(join(uiDir, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid Pages UI file: ' + file);
    if (stat.size > MAX_FILE_BYTES) throw new Error('Pages UI file exceeds size budget: ' + file);
  }
  for (const required of ['index.html', 'workflows.html', 'styles.css', 'workflows.css', 'favicon.svg']) {
    if (!files.includes(required)) throw new Error('Pages UI artifact is missing ' + required);
  }
  return files;
}

async function validateData(dataDir) {
  const files = (await listFiles(dataDir)).sort();
  if (files.length > MAX_DATA_FILES) throw new Error('Pages data artifact exceeds file budget');
  const expected = [...DATA_FILES].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error('Pages data artifact must contain exactly ' + expected.join(', '));
  }
  for (const file of files) {
    const stat = await lstat(join(dataDir, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid Pages data file: ' + file);
    if (stat.size > MAX_TOTAL_BYTES) throw new Error('Pages data file exceeds size budget: ' + file);
    JSON.parse(await readFile(join(dataDir, file), 'utf8'));
  }
  return files;
}

export async function assemblePages({uiDir, dataDir, outDir}) {
  const uiRoot = resolve(uiDir);
  const dataRoot = resolve(dataDir);
  const output = resolve(outDir);
  if (uiRoot === output || dataRoot === output) throw new Error('Assembly inputs must be isolated from the output');
  const uiFiles = await validateUi(uiRoot);
  const dataFiles = await validateData(dataRoot);
  const overlap = uiFiles.filter((file) => dataFiles.includes(file));
  if (overlap.length) throw new Error('Pages assembly collision: ' + overlap.join(', '));
  await rm(output, {recursive: true, force: true});
  await mkdir(output, {recursive: true});
  let total = 0;
  for (const [sourceRoot, files] of [
    [uiRoot, uiFiles],
    [dataRoot, dataFiles],
  ]) {
    for (const file of files) {
      const target = join(output, file);
      await mkdir(dirname(target), {recursive: true});
      await copyFile(join(sourceRoot, file), target);
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Assembled Pages file is invalid: ' + file);
      total += stat.size;
    }
  }
  if (total > MAX_TOTAL_BYTES) throw new Error('Assembled Pages artifact exceeds size budget');
  return {outDir: output, uiFiles, dataFiles, bytes: total};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const uiDir = process.env.PAGES_UI_DIR || join(root, '.build/ui');
  const dataDir = process.env.PAGES_DATA_DIR || join(root, '.build/data');
  const outDir = process.env.PAGES_OUT_DIR || join(root, 'dist');
  const result = await assemblePages({uiDir, dataDir, outDir});
  console.log('Assembled public Pages artifact:', result.outDir);
  console.log(
    JSON.stringify({
      ui_files: result.uiFiles.length,
      data_files: result.dataFiles.length,
      bytes: result.bytes,
    }),
  );
}

export {DATA_FILES, safeRelative};

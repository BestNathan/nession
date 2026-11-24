// Public Pages artifact entrypoint. Three independent inputs are assembled:
//   1. a credential-free Vite UI build (skipped when PAGES_UI_DIR is provided),
//   2. the existing trusted Node/Rust public data projection,
//   3. curated prototype publication (separate publisher, invoked by deploy).
// The orchestrator never rewrites projection or UI semantics.
import {spawnSync} from 'node:child_process';
import {rm, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assemblePages} from './assemble.mjs';
import {writeArtifactManifest} from './artifact-manifest.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const uiDir = resolve(process.env.PAGES_UI_DIR || join(root, '.build/ui'));
const dataDir = resolve(process.env.PAGES_DATA_DIR || join(root, '.build/data'));
const outDir = resolve(process.env.PAGES_OUT_DIR || join(root, 'dist'));

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: {...process.env, ...env},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' ' + args.join(' ') + ' failed');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (process.env.PAGES_UI_DIR) {
  if (!(await exists(uiDir))) throw new Error('PAGES_UI_DIR does not exist: ' + uiDir);
  console.log('Using prebuilt credential-free Pages UI:', uiDir);
} else {
  // Vite owns only this isolated directory; it can never empty data/prototypes.
  await rm(uiDir, {recursive: true, force: true});
  run('npm', ['run', 'build:ui'], {PAGES_UI_OUT_DIR: uiDir});
}

await rm(dataDir, {recursive: true, force: true});
run(process.execPath, [join(root, 'scripts/build-data.mjs')], {PAGES_DATA_OUT_DIR: dataDir});

const assembled = await assemblePages({uiDir, dataDir, outDir});
const manifest = await writeArtifactManifest(outDir);
console.log('Public Pages artifact:', outDir);
console.log(
  JSON.stringify({
    out_dir: outDir,
    ui_files: assembled.uiFiles.length,
    data_files: assembled.dataFiles.length,
    closure_files: manifest.manifest.files.length,
    closure_sha256: manifest.manifest.closure_sha256,
    manifest_sha256: manifest.sha256,
  }),
);

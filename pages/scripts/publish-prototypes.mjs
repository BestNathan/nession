import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

// Publish static, mock-only files from the shared orphan prototype branch.
// This tool is trusted main code; it never imports or executes prototype JS.
const REPO = 'https://github.com/BestNathan/nession';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]+$/;
const ALLOWED = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp']);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 12 * 1024 * 1024;

function requireSha(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Prototype source must be pinned to a 40-character commit SHA');
  return sha;
}
function sourceUrl(sha, path) {
  return REPO + '/blob/' + requireSha(sha) + '/' + path;
}
function decoratedHtml(html, sha, path) {
  if (!/<\/head\s*>/i.test(html) || !/<\/body\s*>/i.test(html)) throw new Error('Invalid HTML entry: ' + path);
  const source = sourceUrl(sha, path);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">`;
  // The source link deliberately lives in the preview, not in a GitHub blob viewer.
  const link = `<a class="nession-preview-source" href="${source}" target="_blank" rel="noopener noreferrer" aria-label="View prototype source on GitHub">View source ↗</a>
<style>.nession-preview-source{position:fixed!important;z-index:2147483600!important;right:12px!important;bottom:12px!important;display:inline-flex!important;padding:8px 12px!important;background:#182d30!important;color:#fff!important;border:1px solid #95b8b5!important;border-radius:999px!important;font:600 12px/1.4 system-ui,sans-serif!important;text-decoration:none!important;box-shadow:0 2px 12px #0003!important}.nession-preview-source:focus-visible{outline:3px solid #43c8b0;outline-offset:2px}</style>`;
  return html.replace(/<\/head\s*>/i, csp + '\n</head>').replace(/<\/body\s*>/i, link + '\n</body>');
}
async function normalFile(file) {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('Not a regular prototype asset: ' + file);
  if (st.size > MAX_FILE) throw new Error('Prototype asset too large: ' + file);
  return st.size;
}

export async function publishPrototypes(sourceDir, outDir, sha) {
  requireSha(sha);
  const input = resolve(sourceDir), output = resolve(outDir);
  if (input === output || output.startsWith(input + '/')) throw new Error('Output must be outside prototype source');
  const root = await readdir(input, { withFileTypes: true });
  const dirs = root.filter(x => x.isDirectory() && SLUG.test(x.name)).map(x => x.name).sort();
  if (!dirs.length) throw new Error('No prototype directories to publish');
  const gallery = join(input, 'index.html');
  let bytes = await normalFile(gallery);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'index.html'), decoratedHtml(await readFile(gallery, 'utf8'), sha, 'index.html'));
  const manifest = { schema_version: 1, source: { branch: 'prototype', sha }, entries: [] };
  for (const slug of dirs) {
    const folder = join(input, slug);
    const items = await readdir(folder, { withFileTypes: true });
    if (!items.some(x => x.name === 'index.html' && x.isFile())) throw new Error('Missing prototype index.html: ' + slug);
    const outFolder = join(output, slug);
    await mkdir(outFolder, { recursive: true });
    let assets = 0;
    for (const item of items) {
      // No executable runner, test harness, metadata, private file, or nested tree
      // enters the public Pages artifact. JS is copied as inert bytes at build time.
      if (!item.isFile() || item.isSymbolicLink()) throw new Error('Unexpected nested/symlink prototype asset: ' + slug + '/' + item.name);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.name)) throw new Error('Invalid prototype asset filename: ' + item.name);
      if (!ALLOWED.has(extname(item.name).toLowerCase()) || /(?:^|[.-])test\.(?:m?js)$/.test(item.name)) continue;
      const path = slug + '/' + item.name;
      bytes += await normalFile(join(folder, item.name));
      if (bytes > MAX_TOTAL) throw new Error('Prototype artifact exceeds size budget');
      if (item.name === 'index.html') {
        await writeFile(join(outFolder, item.name), decoratedHtml(await readFile(join(folder, item.name), 'utf8'), sha, path));
      } else {
        await copyFile(join(folder, item.name), join(outFolder, item.name));
      }
      assets++;
    }
    manifest.entries.push({ slug, preview: 'prototypes/' + slug + '/index.html', source: sourceUrl(sha, slug + '/index.html'), assets });
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && basename(process.argv[1]) === 'publish-prototypes.mjs') {
  const [input, output, sha] = process.argv.slice(2);
  if (!input || !output || !sha) {
    console.error('Usage: node publish-prototypes.mjs <prototype-checkout> <pages-dist-prototypes> <pinned-commit-sha>');
    process.exitCode = 2;
  } else {
    publishPrototypes(input, output, sha).then(x => {
      console.log('Published prototype gallery:', x.entries.map(e => e.slug).join(', '), '@', x.source.sha);
    }).catch(error => { console.error(error); process.exitCode = 1; });
  }
}

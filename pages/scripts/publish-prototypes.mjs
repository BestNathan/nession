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
  // Stable Pages navigation is injected into the mock, without rewriting the
  // mock design. The source viewer is intentionally secondary to the HTML.
  const bar = `<nav class="nession-preview-nav" aria-label="Nession prototype navigation">
  <a href="../../#/prototypes" class="nession-preview-home" aria-label="Back to Nession prototype gallery">← Nession / Prototypes</a>
  <span>INTERACTIVE MOCK</span>
  <a href="${source}" class="nession-preview-source" target="_blank" rel="noopener noreferrer" aria-label="View prototype source on GitHub">View source ↗</a>
</nav>
<style>
.nession-preview-nav{position:fixed!important;z-index:2147483600!important;right:14px!important;bottom:14px!important;display:flex!important;align-items:center!important;gap:12px!important;max-width:calc(100vw - 28px)!important;flex-wrap:wrap!important;padding:9px 12px!important;background:#fffefa!important;color:#183c36!important;border:1px solid #b6ccbf!important;border-radius:14px!important;font:600 12px/1.4 system-ui,sans-serif!important;box-shadow:0 8px 25px #132b2840!important}
.nession-preview-nav a{color:#183c36!important;text-decoration:none!important;font:inherit!important;white-space:nowrap!important}
.nession-preview-nav a:hover{text-decoration:underline!important;text-underline-offset:3px!important}
.nession-preview-nav>span{color:#74857c!important;font:500 9px/1.4 ui-monospace,monospace!important;letter-spacing:.5px!important}
.nession-preview-nav .nession-preview-source{border-left:1px solid #c6d6cb!important;padding-left:11px!important}
.nession-preview-nav a:focus-visible{outline:3px solid #43c8b0!important;outline-offset:2px!important}
@media(max-width:580px){.nession-preview-nav{left:10px!important;right:10px!important;bottom:10px!important;justify-content:space-between!important;gap:6px!important;padding:9px!important}.nession-preview-nav>span{display:none!important}.nession-preview-nav a{font-size:11px!important}}
</style>`;
  return html.replace(/<\/head\s*>/i, csp + '\n</head>').replace(/<\/body\s*>/i, bar + '\n</body>');
}

function integratedGalleryRedirect() {
  // The canonical index is a Pages route. Older /prototypes/ bookmarks should
  // land on the same native application shell, never on a second visual system.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=../#/prototypes">
<title>Prototypes — Nession</title><link rel="icon" href="../favicon.svg"><link rel="stylesheet" href="../styles.css">
</head><body><main class="site"><section class="page-head"><div class="eyebrow">NESSION / DESIGN LAB</div>
<h1>Explore prototypes.</h1><p class="lede">The interactive library now lives inside Nession Pages.</p>
<p><a class="action" href="../#/prototypes">Open the prototype library ↗</a></p>
</section></main></body></html>`;
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
  const originalGallery = await readFile(gallery, 'utf8');
  if(!/<\/head\s*>/i.test(originalGallery) || !/<\/body\s*>/i.test(originalGallery))
    throw new Error('Invalid HTML entry: index.html');
  await writeFile(join(output, 'index.html'), integratedGalleryRedirect());
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

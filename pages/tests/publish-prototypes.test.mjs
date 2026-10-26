import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPrototypes } from '../scripts/publish-prototypes.mjs';

const SHA = 'a'.repeat(40);
const HTML = '<!doctype html><html><head><title>Mock</title></head><body><h1>Interactive</h1></body></html>';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'nession-prototype-publisher-'));
  const source = join(root, 'prototype'), output = join(root, 'dist', 'prototypes');
  await mkdir(join(source, 'terminal-fixed-cols-2487'), { recursive: true });
  await writeFile(join(source, 'index.html'), HTML);
  await writeFile(join(source, 'terminal-fixed-cols-2487', 'index.html'), HTML);
  await writeFile(join(source, 'terminal-fixed-cols-2487', 'app.js'), 'window.isMock = true;');
  await writeFile(join(source, 'terminal-fixed-cols-2487', 'smoke-test.mjs'), 'throw Error("must not execute");');
  await writeFile(join(source, 'terminal-fixed-cols-2487', 'README.md'), 'mock only');
  try { await run(source, output); } finally { await rm(root, { recursive: true, force: true }); }
}

test('publishes independently navigable HTML with pinned source link and inert assets', async () => {
  await fixture(async (source, output) => {
    const manifest = await publishPrototypes(source, output, SHA);
    assert.equal(manifest.source.sha, SHA);
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].preview, 'prototypes/terminal-fixed-cols-2487/index.html');
    const html = await readFile(join(output, 'terminal-fixed-cols-2487', 'index.html'), 'utf8');
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /View source/);
    assert.match(html, new RegExp('github.com/BestNathan/nession/blob/' + SHA + '/terminal-fixed-cols-2487/index.html'));
    assert.match(await readFile(join(output, 'index.html'), 'utf8'), new RegExp('blob/' + SHA + '/index.html'));
    assert.equal(await readFile(join(output, 'terminal-fixed-cols-2487', 'app.js'), 'utf8'), 'window.isMock = true;');
    assert.deepEqual((await readdir(join(output, 'terminal-fixed-cols-2487'))).sort(), ['app.js', 'index.html']);
  });
});

test('fails closed on missing SHA, malformed HTML, and unreviewed symbolic links', async () => {
  await fixture(async (source, output) => {
    await assert.rejects(() => publishPrototypes(source, output, 'prototype'), /40-character/);
    await writeFile(join(source, 'index.html'), 'not a document');
    await assert.rejects(() => publishPrototypes(source, output, SHA), /Invalid HTML/);
    await writeFile(join(source, 'index.html'), HTML);
    await symlink('index.html', join(source, 'terminal-fixed-cols-2487', 'not-safe.css'));
    await assert.rejects(() => publishPrototypes(source, output, SHA), /symlink/);
  });
});

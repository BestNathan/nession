'use strict';
// #2654 SC-06: the published prototype is pinned, byte-identical to its
// immutable source, and still linked with its fidelity limits. This verifier
// reads only public read-only URLs; it never writes the prototype branch.
const crypto = require('node:crypto');
const {
  emitFailure,
  emitPass,
  runtimeFromEnv,
} = require('../../../shared/session-env-binding-cases.cjs');

const PINNED_SHA = '9fcfde850ef7a7d0543e405aac08be0d27f6c22f';
const PINNED_HTML_SHA256 = '427fc98e404751d6f10761e55a4ee404616436201d323a138ad92336de540c5c';
const SLUG = 'environment-session-2654';
const PAGES = 'https://bestnathan.github.io/nession';
const RAW = 'https://raw.githubusercontent.com/BestNathan/nession/';
const PREVIEW = PAGES + '/prototypes/' + SLUG + '/index.html';
const MANIFEST = PAGES + '/prototypes/manifest.json';

async function fetchText(url, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: { 'cache-control': 'no-cache' },
      });
      if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
      return await response.text();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw last;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

(async () => {
  try {
    const runtime = runtimeFromEnv();

    const manifest = JSON.parse(await fetchText(MANIFEST));
    if (manifest?.schema_version !== 1) throw new Error('manifest schema_version is not 1');
    const sourceSha = String(manifest?.source?.sha ?? '');
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('manifest source SHA is missing');
    const entry = (manifest.entries ?? []).find((item) => item.slug === SLUG);
    if (!entry) throw new Error('manifest has no ' + SLUG + ' entry');
    if (entry.preview !== 'prototypes/' + SLUG + '/index.html') {
      throw new Error('manifest preview path is ' + entry.preview);
    }
    if (!String(entry.source).includes('/blob/' + sourceSha + '/' + SLUG + '/index.html')) {
      throw new Error('manifest source link does not name its own pinned SHA');
    }

    const pinned = await fetchText(RAW + PINNED_SHA + '/' + SLUG + '/index.html');
    if (sha256(pinned) !== PINNED_HTML_SHA256) {
      throw new Error('pinned prototype bytes changed: ' + sha256(pinned));
    }
    const publishedSource = await fetchText(RAW + sourceSha + '/' + SLUG + '/index.html');
    if (publishedSource !== pinned) {
      throw new Error('Pages manifest source differs from the pinned prototype source');
    }

    const preview = await fetchText(PREVIEW);
    for (const marker of [
      'Nession · Session Environment prototype #2654',
      'INTERACTIVE MOCK',
      'Back to Nession prototype gallery',
      'Manage binding',
      'Reapply explicitly',
    ]) {
      if (!preview.includes(marker)) throw new Error('published preview is missing: ' + marker);
    }
    if (!preview.includes(sourceSha)) {
      throw new Error('published preview does not link its manifest source SHA');
    }

    const readme = await fetchText(RAW + PINNED_SHA + '/' + SLUG + '/README.md');
    if (!readme.includes('Requirement #2654')) throw new Error('README does not link Requirement #2654');
    if (!/synthetic|fidelity|mock/i.test(readme)) {
      throw new Error('README does not state its mock/fidelity limits');
    }

    emitPass(
      'The live Pages manifest, preview and immutable prototype source agree, and the pinned source documents its mock limits.',
      [
        { type: 'runtime', value: 'target_sha=' + runtime.target_sha + ' profile=' + runtime.profile },
        { type: 'prototype', value: 'manifest source=' + sourceSha + ' entry=' + entry.preview },
        { type: 'prototype', value: 'pinned ' + PINNED_SHA + ' index.html sha256=' + PINNED_HTML_SHA256 + ' equals manifest-source bytes' },
        { type: 'prototype', value: 'preview HTTP 200 markers=title,INTERACTIVE MOCK,gallery link,Manage binding,Reapply explicitly,source link' },
        { type: 'prototype', value: 'README ' + PINNED_SHA + ' links Requirement #2654 and states its mock/fidelity limits' },
      ],
    );
  } catch (error) {
    emitFailure(error);
  }
})();

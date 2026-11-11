#!/usr/bin/env node
// Dependency-free static contract checks for the Images (#3181) prototype.
// This proves only that the artifact declares the expected frame/product hooks
// and scenarios. It does not prove browser behavior or publication freshness.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');
const failures = [];
const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push({ name, detail });
}
function count(pattern) {
  return (html.match(pattern) || []).length;
}

check('frame root opt-in', /<body data-nession-prototype-frame="v1">/.test(html));
check('np-page root', /class="np-page"[^>]*data-np-root/.test(html));
check('shared frame CSS', html.includes('../prototype-frame-2758/frame.css'));
check('shared frame JS', html.includes('../prototype-frame-2758/frame.js'));
check('exactly one gallery link', count(/data-nession-gallery-link/g) === 1);
check('gallery href points to prototype gallery', /data-nession-gallery-link href="\.\.\/\.\.\/#\/prototypes"/.test(html));
check('exactly one source link', count(/data-nession-source-link/g) === 1);
check('source link points to this directory', /data-nession-source-link href="https:\/\/github\.com\/BestNathan\/nession\/tree\/prototype\/images-3181"/.test(html));
check('four size presets', ['1180', '1024', '390', '375'].every((size) => html.includes(`data-np-size="${size}"`)));
check('reset control', /data-np-reset/.test(html));
check('resize contract listener', /addEventListener\('np:resize'/.test(html));
check('235-image fixture', /Array\.from\(\{length:235\}/.test(html));
check('page size 50', /const PAGE_SIZE = 50;/.test(html));
check('six scenario fixtures', ['normal', 'empty', 'unavailable', 'buildfail', 'agentfail', 'aliasshift'].every((s) => html.includes(`<option value="${s}"`)));
check('workspace entry hook', /data-open-images/.test(html));
check('inventory list hook', /id="image-list"/.test(html));
check('image detail hook', /id="image-detail"/.test(html));
check('Project independent selector hooks', /data-open-project-select/.test(html) && /data-project-pick/.test(html) && /data-close-project-chooser/.test(html));
check('Sandbox independent composition hooks', /data-open-sandbox-add/.test(html) && /data-sandbox-pick/.test(html) && /data-sandbox-target/.test(html) && /data-sandbox-mode/.test(html) && /data-sandbox-commit/.test(html) && /data-close-sandbox-add/.test(html));
check('independent-flow copy present', /Project-specific single-image reference flow/.test(html) && /Sandbox-specific flow/.test(html));
check('no shared Picker claim', !/one shared Picker|same Picker/i.test(html));
check('build success bind hook', /data-build-use/.test(html));
check('build failure copy preserves reference', /Build failed/.test(html));
check('agent readiness separately labelled', /Agent · /.test(html) && /Server · /.test(html));
check('alias pin explanation', /alias now resolves/.test(html));
check('sandbox target/mode controls', /data-target=/.test(html) && /data-mode=/.test(html));
check('app back owner', /id="app-back"/.test(html));
check('no external script', count(/<script[^>]+src="https?:/g) === 0);
check('no external stylesheet', count(/<link[^>]+href="https?:/g) === 0);
check('no fetch/XHR in mock', !/\b(fetch|XMLHttpRequest)\s*\(/.test(html));
check('no obvious secret material', !/(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i.test(html));

const inlineScript = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
check('inline script present', Boolean(inlineScript));
if (inlineScript) {
  try {
    new Function(inlineScript[1]);
    checks.push({ name: 'inline script parses', ok: true, detail: '' });
  } catch (error) {
    check('inline script parses', false, error.message);
  }
}

for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}

/**
 * Copy every bundled font's licence text into `dist/licenses/`.
 *
 * The fonts are OFL 1.1, which permits commercial embedding and redistribution
 * only if the copyright notice and the full licence travel with each copy. A
 * build that copies the `.woff2` files and leaves the licence behind in
 * `node_modules/` is not compliant — and `node_modules/` is not shipped.
 *
 * Riding in `dist/` rather than being copied by each Dockerfile means the
 * licence reaches every image (server, agent, ui) through the one artifact
 * they already share, including the prebuilt variants that receive `dist/` as
 * a build context and never see `node_modules/`.
 */
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(WEB_DIR, 'dist', 'licenses');

/** Font packages are whatever the project actually depends on — not a list
 *  restated here, which would drift the moment a font is added. */
function fontPackages() {
  const pkg = JSON.parse(readFileSync(join(WEB_DIR, 'package.json'), 'utf8'));
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => name.startsWith('@fontsource'))
    .sort();
}

const packages = fontPackages();
if (packages.length === 0) {
  console.error('✗ no @fontsource packages found — did the fonts get dropped?');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

let failed = false;
for (const name of packages) {
  const source = join(WEB_DIR, 'node_modules', name, 'LICENSE');
  if (!existsSync(source)) {
    console.error(`✗ ${name} ships no LICENSE file`);
    console.error('  Fix: ship the OFL text, or drop the font.');
    failed = true;
    continue;
  }
  copyFileSync(source, join(OUT_DIR, `${name.replace(/[@/]/g, '-').replace(/^-/, '')}.txt`));
  console.log(`✓ ${name} → dist/licenses/`);
}
if (failed) process.exit(1);

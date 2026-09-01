import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveRef,
  generateWebCss,
  generateLintMetadata,
  generateAppTs,
} from './generate-tokens.mjs';

const fixture = {
  primitive: {
    color: {
      zinc: {
        50: { value: 'oklch(0.985 0 0)' },
        500: { value: 'oklch(0.556 0 0)' },
        950: { value: 'oklch(0.145 0 0)' },
      },
      green: { 500: { value: 'oklch(0.63 0.17 145)' } },
    },
  },
  semantic: {
    themes: {
      light: {
        background: { ref: 'primitive.color.zinc.50' },
        'muted-foreground': { ref: 'primitive.color.zinc.500' },
        success: { ref: 'primitive.color.green.500' },
      },
      dark: {
        background: { ref: 'primitive.color.zinc.950' },
        'muted-foreground': { ref: 'primitive.color.zinc.500' },
        success: { ref: 'primitive.color.green.500' },
      },
    },
  },
  domain: {
    agent: {
      online: { ref: 'primitive.color.green.500' },
      connecting: { ref: 'semantic.muted-foreground' },
    },
  },
  experience: {
    web: { control: { sm: { value: '28px' } } },
    app: {
      touchTarget: { min: { value: 44 } },
      control: { md: { value: '44px' } },
    },
  },
};

const RAW_COLOR = /oklch\(|rgb\(|#[0-9a-fA-F]{3,8}\b/;

function findRawColor(node, path = '') {
  if (typeof node === 'string') {
    return RAW_COLOR.test(node) ? path || node : null;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findRawColor(node[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'ref' || key.startsWith('$')) continue;
      const found = findRawColor(value, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

test('resolveRef follows primitive color refs to a value object', () => {
  assert.deepEqual(resolveRef({ ref: 'primitive.color.green.500' }, fixture), {
    value: 'oklch(0.63 0.17 145)',
  });
});

test('resolveRef throws when the ref path is missing', () => {
  assert.throws(
    () => resolveRef({ ref: 'primitive.color.missing.999' }, fixture),
    /missing ref|not found/i,
  );
});

test('generateWebCss emits light and dark semantic background and @theme success bridge', () => {
  const css = generateWebCss(fixture);
  assert.match(css, /:root\s*\{[^}]*--background:\s*oklch\(0\.985 0 0\)/s);
  assert.match(css, /\.dark\s*\{[^}]*--background:\s*oklch\(0\.145 0 0\)/s);
  assert.match(css, /@theme inline\s*\{[^}]*--color-success:\s*var\(--success\);/s);
});

test('generateWebCss emits domain --agent-online and --agent-connecting', () => {
  const css = generateWebCss(fixture);
  assert.match(css, /--agent-online\b/);
  assert.match(css, /--agent-connecting\b/);
});

test('generateWebCss scopes App density vars under [data-experience=app] only', () => {
  const css = generateWebCss(fixture);
  assert.doesNotMatch(css, /control-app-/);
  const rootBlock = css.match(/:root\s*\{([^}]*)\}/s)?.[1] ?? '';
  assert.doesNotMatch(rootBlock, /--touch-target-min:/);
  assert.match(css, /\[data-experience="app"\][\s\S]*--touch-target-min:\s*44/);
});

test('generateWebCss emits [data-experience=app] control remap', () => {
  const css = generateWebCss(fixture);
  assert.match(css, /\[data-experience="app"\]\s*\{[^}]*--control-md:\s*44px/s);
});

test('generateLintMetadata marks green-500 as a primitive forbidden in components', () => {
  const meta = generateLintMetadata(fixture);
  assert.equal(meta['green-500'].layer, 'primitive');
  assert.equal(meta['green-500'].allowedInComponent, false);
  assert.ok(meta['green-500'].suggestions.includes('success'));
  assert.ok(meta['green-500'].suggestions.includes('agent-online'));
});

test('generateAppTs exports numeric touchTarget.min === 44', () => {
  const src = generateAppTs(fixture);
  const js = src
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\bas const\b/g, '')
    .replace(/\bexport\s+/g, '');
  const min = new Function(`${js}; return touchTarget.min;`)();
  assert.equal(min, 44);
});

test('fixture domain tokens contain no raw oklch / hex / rgb values', () => {
  assert.equal(findRawColor(fixture.domain), null);
});

test('production domain.json contains no raw oklch / hex / rgb values', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../tokens/domain.json');
  const json = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(findRawColor(json), null);
});

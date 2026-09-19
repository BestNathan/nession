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
  generateTerminalTs,
  TERMINAL_THEME_SLOTS,
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
    terminal: {
      background: { value: '#ffffff' },
      foreground: { value: '#24292f' },
      cursor: { value: '#0969da' },
      'cursor-accent': { value: '#ffffff' },
      'selection-background': { value: '#0969da33' },
      'selection-foreground': { value: '#24292f' },
      'minimum-contrast-ratio': { value: 4.5 },
      ...Object.fromEntries(
        TERMINAL_THEME_SLOTS.filter(([, key]) => key.startsWith('ansi-')).map(
          ([, key], i) => [key, { value: `#00000${i.toString(16)}` }],
        ),
      ),
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
  assert.ok(meta['green-500'].suggestions.includes('agent-online'));
  assert.ok(meta['green-500'].suggestions.includes('muted-foreground'));
  assert.ok(!meta['green-500'].suggestions.includes('success'));
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

test('production web.css uses one composer body size on web and app', () => {
  const generatedCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../generated/web.css'),
    'utf8',
  );
  const rootMatch = generatedCss.match(/:root \{[\s\S]*?--terminal-capsule-font-size: ([^;]+);/);
  const appBlock = generatedCss.match(/\[data-experience="app"\] \{([\s\S]*?)\n\}/);
  assert.equal(rootMatch?.[1]?.trim(), '1rem');
  assert.match(appBlock?.[1] ?? '', /--terminal-capsule-font-size: 1rem/);
  assert.match(appBlock?.[1] ?? '', /--terminal-capsule-quick-key-font-size: 1rem/);
  assert.match(appBlock?.[1] ?? '', /--terminal-capsule-phys-key-font-size: 1rem/);
  assert.match(appBlock?.[1] ?? '', /--terminal-capsule-caption-font-size: 1rem/);
});

test('generateTerminalTs fills every xterm ITheme colour slot', () => {
  const src = generateTerminalTs(fixture);
  for (const [slot] of TERMINAL_THEME_SLOTS) {
    assert.match(src, new RegExp(`\\b${slot}: "#`), `missing slot ${slot}`);
  }
  assert.match(src, /TERMINAL_MINIMUM_CONTRAST_RATIO = 4\.5;/);
});

test('generateTerminalTs throws rather than emitting an undefined slot', () => {
  const broken = structuredClone(fixture);
  delete broken.primitive.terminal['ansi-bright-cyan'];
  assert.throws(
    () => generateTerminalTs(broken),
    /missing ref: primitive\.terminal\.ansi-bright-cyan/,
  );
});

// The terminal background is the Session canvas: the chrome's ground must equal
// the terminal's ground or the surface edge reads as a seam. Both are literals
// in primitive.json (oklch for chrome, hex for xterm), so pairing them here is
// what keeps them from drifting apart.
test('production terminal background equals the light chrome ground', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const terminalTs = readFileSync(join(dir, '../generated/terminal.ts'), 'utf8');
  const css = readFileSync(join(dir, '../generated/web.css'), 'utf8');
  const background = terminalTs.match(/\bbackground: "(#[0-9a-fA-F]{6})"/)?.[1];
  assert.equal(background?.toLowerCase(), '#ffffff');
  assert.match(css, /:root \{[\s\S]*?--background: oklch\(1 0 0\);/);
});

test('production terminal.ts carries no Catppuccin Mocha leftover', () => {
  const terminalTs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../generated/terminal.ts'),
    'utf8',
  );
  assert.doesNotMatch(terminalTs, /1e1e2e|cdd6f4|89b4fa/i);
});

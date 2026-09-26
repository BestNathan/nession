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
  loadTokens,
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
    web: {
      control: { sm: { value: '28px' } },
      // `generateTerminalTs` requires the group on both sides: the xterm
      // boundary needs the metrics as JS, and the fixture is what proves it
      // does not silently emit `undefined` when they are absent.
      terminal: {
        fontSize: { value: '12.5px' },
        lineHeight: { value: 1.62 },
        padX: { value: '18px' },
        padY: { value: '18px' },
      },
    },
    app: {
      touchTarget: { min: { value: 44 } },
      control: { md: { value: '44px' } },
      terminal: {
        fontSize: { value: '11.5px' },
        lineHeight: { value: 1.7 },
        padX: { value: '14px' },
        padY: { value: '14px' },
      },
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

test('generateTerminalTs carries both experiences\' terminal metrics as numbers', () => {
  const src = generateTerminalTs(fixture);
  // px values arrive as numbers, not strings: xterm takes `fontSize` in px and
  // `lineHeight` as a multiplier, so a `"12.5px"` string would be unusable.
  assert.match(src, /export const TERMINAL_METRICS = \{/);
  assert.match(src, /web: \{\s*fontSize: 12\.5,\s*lineHeight: 1\.62,\s*padX: 18,\s*padY: 18,\s*\}/);
  assert.match(src, /app: \{\s*fontSize: 11\.5,\s*lineHeight: 1\.7,\s*padX: 14,\s*padY: 14,\s*\}/);
  assert.match(src, /\} as const;/);
});

test('generateTerminalTs throws when an experience declares no terminal metrics', () => {
  const broken = structuredClone(fixture);
  delete broken.experience.app.terminal;
  assert.throws(() => generateTerminalTs(broken), /missing ref: experience\.app\.terminal/);
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

// ── #1073: the App owns its chrome type scale ──────────────────────────────
//
// `experience.web.typography` is emitted at `:root`, so before this group
// existed every shared shell/workspace text token the App consumed resolved to
// Web's desktop density. These tests pin the two halves of the fix: the App
// group states its own values, and the shared pattern tokens derive from it.

/** The App's chrome roles, in the order the ramp descends. */
const APP_ROLES = ['title', 'primary', 'body', 'secondary', 'metadata', 'code'];

/** Shared pattern tokens that must be remapped, not inherited. */
const REMAPPED_TEXT_TOKENS = [
  ['shell', 'sessionRowTitleFontSize'],
  ['shell', 'sessionRowMetaFontSize'],
  ['shell', 'nodeFontSize'],
  ['shell', 'sectionHeadFontSize'],
  ['shell', 'footFontSize'],
  ['workspace', 'treeFontSize'],
  ['workspace', 'editorHeadFontSize'],
  ['workspace', 'listRowTitleFontSize'],
  ['workspace', 'editorActionFontSize'],
];

const APP_BLOCK = '\\[data-experience="app"\\]';

function readGeneratedWebCss() {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../generated/web.css'),
    'utf8',
  );
}

/** The custom property's value inside a named block of the generated CSS. */
function cssValueIn(css, block, name) {
  const body = css.match(new RegExp(`${block} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  return body.match(new RegExp(`--${name}: ([^;]+);`))?.[1]?.trim() ?? null;
}

test('the App states its own typography roles rather than aliasing Web\'s', () => {
  const tokens = loadTokens();
  for (const role of APP_ROLES) {
    const leaf = tokens.experience?.app?.typography?.[role]?.size;
    assert.ok(leaf, `experience.app.typography.${role}.size is missing`);
    // A `ref` into Web's group would satisfy the schema while making the App
    // inherit the exact values this group exists to stop inheriting (#1073:
    // "Do not make App values aliases to Web values merely to satisfy the
    // schema").
    assert.ok(
      'value' in leaf,
      `experience.app.typography.${role}.size refs ${leaf.ref} instead of stating the App's own size`,
    );
  }
});

test('the App scale descends, so no two roles are a coincidence apart', () => {
  const tokens = loadTokens();
  const size = (role) =>
    Number.parseFloat(resolveRef(tokens.experience.app.typography[role].size, tokens).value);
  // Every step in the ramp is a real step: a role that did not separate from
  // its neighbour would be two names for one value, which is the fragmentation
  // with extra vocabulary.
  for (let i = 0; i < APP_ROLES.length - 2; i += 1) {
    assert.ok(
      size(APP_ROLES[i]) > size(APP_ROLES[i + 1]),
      `${APP_ROLES[i]} (${size(APP_ROLES[i])}px) does not lead ${APP_ROLES[i + 1]} (${size(APP_ROLES[i + 1])}px)`,
    );
  }
  // `code` is a sibling of `secondary` rather than a step below `metadata`:
  // mono is a family, not a smaller size (#1073 criterion 6).
  assert.ok(size('code') >= size('metadata'));
  assert.ok(size('title') > size('code'));
});

test('every shared pattern text token is remapped by Experience, not inherited', () => {
  const tokens = loadTokens();
  for (const [group, leaf] of REMAPPED_TEXT_TOKENS) {
    const appLeaf = tokens.experience?.app?.[group]?.[leaf];
    const webLeaf = tokens.experience?.web?.[group]?.[leaf];
    assert.ok(
      webLeaf,
      `experience.web.${group}.${leaf} is missing — the shared class would resolve to nothing at :root`,
    );
    assert.ok(
      appLeaf,
      `experience.app.${group}.${leaf} is missing — App chrome would inherit Web's density`,
    );
    // The role, not the number: a value copied here would keep the App's text
    // on Web's scale the moment the App scale moved.
    assert.match(
      String(appLeaf.ref ?? ''),
      /^experience\.app\.typography\./,
      `experience.app.${group}.${leaf} must derive from an App typography role`,
    );
    assert.notEqual(
      resolveRef(appLeaf, tokens).value,
      resolveRef(webLeaf, tokens).value,
      `experience.app.${group}.${leaf} resolves to Web's value — the remap is a no-op`,
    );
  }
});

test('generated CSS carries the App scale under the App experience only', () => {
  const css = readGeneratedWebCss();
  for (const role of APP_ROLES) {
    assert.ok(
      cssValueIn(css, APP_BLOCK, `typography-${role}-size`),
      `--typography-${role}-size is not emitted under [data-experience="app"]`,
    );
  }
  // Three shared tokens the App remaps: the Web value stays at :root and the
  // App value replaces it inside the App. Equal values would mean the leak is
  // back — which is exactly the shape #1073 recorded.
  const remapped = [
    'shell-session-row-title-font-size',
    'shell-foot-font-size',
    'workspace-tree-font-size',
  ];
  for (const name of remapped) {
    const root = cssValueIn(css, ':root', name);
    const app = cssValueIn(css, APP_BLOCK, name);
    assert.ok(root, `--${name} is missing at :root`);
    assert.ok(app, `--${name} is missing under [data-experience="app"]`);
    assert.notEqual(app, root, `--${name} has the same value in both experiences`);
  }
});

test('the two App-only roles are declared App-only to the lint', () => {
  const vars = generateLintMetadata(loadTokens()).experienceAppVars;
  // `title` and `body` have no Web leaf, so they exist only under the App
  // experience — and a binding that names one has to say which experience it
  // belongs to (`nession/no-cross-experience-token`). If this list lost them
  // the rule would stop protecting every App chrome class.
  assert.ok(vars.includes('typography-title-size'), 'typography-title-size is not declared App-only');
  assert.ok(vars.includes('typography-body-size'), 'typography-body-size is not declared App-only');
  // The four shared roles also resolve at :root, so they are not App-only and
  // a Web-side binding is not a hazard.
  for (const role of ['primary', 'secondary', 'metadata', 'code']) {
    assert.ok(
      !vars.includes(`typography-${role}-size`),
      `typography-${role}-size is declared App-only, but Web states it too`,
    );
  }
});

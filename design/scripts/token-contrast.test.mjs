import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The contrast matrix, executable.
 *
 * These numbers used to live only in the design document, and a document
 * cannot fail a build: every accent was verified against the canvas (#FFFFFF)
 * while the chrome surface (#F6F8FA) went unchecked, so `text.muted` shipped
 * at 4.37:1 on the surface most of it actually sits on — the sidebar. A
 * foreground token must clear AA on *every* ground it can be placed on, and
 * the chrome is the darker one, so it is the binding constraint.
 */

const TOKENS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../tokens/primitive.json'), 'utf8'),
);

const OKLCH_RE = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/;
const HEX_RE = /^#([0-9a-f]{6})$/i;

/** oklch -> linear sRGB -> encoded sRGB. */
function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function hexToRgb(hex) {
  const match = HEX_RE.exec(hex);
  assert.ok(match, `not a 6-digit hex colour: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(match[1].slice(i - 1, i + 1), 16) / 255);
}

/** Any colour the token source can express, as sRGB. */
function toRgb(value) {
  const oklch = OKLCH_RE.exec(value);
  if (oklch) {
    return oklchToRgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  }
  if (HEX_RE.test(value)) {
    return hexToRgb(value);
  }
  throw new Error(`unsupported colour value: ${value}`);
}

const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = TOKENS.light;
const value = (path) => {
  const node = path.split('.').reduce((acc, key) => acc?.[key], light);
  assert.ok(node?.value, `primitive.light.${path} has no value`);
  return node.value;
};

const CANVAS = value('neutral.ground');
const CHROME = value('neutral.surface');
const GROUNDS = [
  ['canvas', CANVAS],
  ['chrome', CHROME],
];

const AA = 4.5;

/**
 * Every token that is read as text, and therefore owes AA on every ground.
 * Separators (`line`, `line-strong`), fills (`fill`, `surface`) and the
 * reverse-video ANSI slots are not text and are deliberately absent — P7 makes
 * separation the weakest cue that works, and `white`/`brightWhite` are
 * background slots in a light terminal.
 */
const TEXT_TOKENS = [
  'neutral.text-primary',
  'neutral.text-secondary',
  'neutral.text-muted',
  'location.local',
  'location.remote',
  'action',
  'state.danger',
  'state.warning',
];

/**
 * `text.disabled` is the one exemption, and it is WCAG's, not ours: 1.4.3
 * exempts inactive controls. It still owes the 3:1 of a perceivable UI
 * boundary so a disabled field never disappears.
 */
const DISABLED_FLOOR = 3;

test('every text token clears AA on both the canvas and the chrome', () => {
  const failures = [];
  for (const token of TEXT_TOKENS) {
    const rgb = toRgb(value(token));
    for (const [name, ground] of GROUNDS) {
      const ratio = contrast(rgb, toRgb(ground));
      if (ratio < AA) {
        failures.push(`primitive.light.${token} on ${name}: ${ratio.toFixed(2)}:1 < ${AA}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], `contrast below AA:\n  ${failures.join('\n  ')}`);
});

test('the input boundary clears the 3:1 perceivable-boundary floor on both grounds', () => {
  // `border.input` is the only cue that says a field is a field — the fill is
  // the same ground — so it owes the 3:1 that `visual-language.md` already
  // applies to `text-disabled` as "a perceivable UI boundary" (WCAG 1.4.11).
  //
  // It used to be `line-strong` at 1.34:1 on the chrome. That was not a near
  // miss to nudge: the whole neutral ramp stops at 1.43:1, and the next step up
  // is a *text* grey. Reaching the floor needs a dedicated step, which is why
  // `neutral.boundary` exists rather than `line-strong` being darkened — the
  // ramp's quiet greys are still wanted for every other line on screen.
  const rgb = toRgb(value('neutral.boundary'));
  for (const [name, ground] of GROUNDS) {
    const ratio = contrast(rgb, toRgb(ground));
    assert.ok(ratio >= DISABLED_FLOOR, `neutral.boundary on ${name} is ${ratio.toFixed(2)}:1`);
  }
});

test('text-disabled holds its 3:1 floor without pretending to be readable', () => {
  const rgb = toRgb(value('neutral.text-disabled'));
  for (const [name, ground] of GROUNDS) {
    const ratio = contrast(rgb, toRgb(ground));
    assert.ok(ratio >= DISABLED_FLOOR, `text-disabled on ${name} is ${ratio.toFixed(2)}:1`);
    assert.ok(ratio < AA, 'text-disabled now clears AA — fold it back into TEXT_TOKENS');
  }
});

/**
 * `local` and `remote` must read as peers, so their lightness has to match
 * within the JND (~0.02 in OKLab L). It cannot match exactly: identical oklch
 * lightness does not mean identical WCAG contrast, and each hue reaches AA on
 * the chrome at a slightly different L. Compliance outranks bit-equality, and
 * the residual offset stays below the threshold where it would read as weight.
 */
test('the two locations are matched in lightness and opposite in hue', () => {
  const local = OKLCH_RE.exec(value('location.local'));
  const remote = OKLCH_RE.exec(value('location.remote'));
  assert.ok(local && remote);
  const [, localL, localC, localH] = local.map(Number);
  const [, remoteL, remoteC, remoteH] = remote.map(Number);
  // JND is ~0.02 in OKLab lightness; half of that reads as one weight.
  assert.ok(Math.abs(localL - remoteL) < 0.02, `ΔL ${Math.abs(localL - remoteL)} is not sub-JND`);
  assert.ok(Math.abs(localC - remoteC) < 0.02, `ΔC ${Math.abs(localC - remoteC)} is not matched`);
  const arc = Math.abs(localH - remoteH);
  assert.ok(Math.abs(arc - 200) < 5, `hue arc ${arc}° is not the 55 <-> 255 pair`);
});

test('every ANSI text slot clears AA on the terminal background', () => {
  const terminal = TOKENS.terminal;
  const background = terminal.background.value;
  const failures = [];
  for (const [key, node] of Object.entries(terminal)) {
    if (!key.startsWith('ansi-')) continue;
    // Reverse-video background slots, not text. In a light terminal the
    // foreground role is carried by `foreground`; "fixing" these by darkening
    // them breaks reverse video.
    if (key === 'ansi-white' || key === 'ansi-bright-white') continue;
    const ratio = contrast(toRgb(node.value), toRgb(background));
    if (ratio < AA) {
      failures.push(`primitive.terminal.${key}: ${ratio.toFixed(2)}:1 < ${AA}:1`);
    }
  }
  assert.deepEqual(failures, [], `ANSI slots below AA:\n  ${failures.join('\n  ')}`);
});

test('the terminal foreground clears AA on the terminal background', () => {
  const terminal = TOKENS.terminal;
  assert.ok(
    contrast(toRgb(terminal.foreground.value), toRgb(terminal.background.value)) >= AA,
  );
});

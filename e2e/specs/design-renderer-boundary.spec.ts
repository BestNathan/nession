// #759 SC9 — a declared third-party renderer boundary must be verified at the
// *rendered* result, not at the source.
//
// CodeMirror injects its own stylesheet into the document after ours, with
// selectors of equal specificity. A Tailwind utility naming the right token
// therefore loses the cascade and renders at CodeMirror's default metrics while
// the source still reads as correct. Measured on the running editor before this
// spec existed: `leading-*`, `min-w-*`, `py-*` and `border-0` were all silently
// dropped, while `opacity-65` survived — a partial application that looks like
// it worked. `editorTheme.ts` moved those decisions into `EditorView.theme`.
//
// This spec is what keeps that from regressing silently. It compares computed
// values against the design tokens the theme claims to consume; nothing here
// restates a px value, so a token change moves the expectation with it.
//
// The counterpart to the "did the elements exist" guard below: a missing
// selector must fail loudly. An assertion built on an empty query returns a
// confident zero and passes forever.
import { expect, test } from '@playwright/test';
import { gotoFixtureWorkspace, openFixtureFile } from '../helpers/fixtureVisual';

test.skip(!process.env.CI, 'local only — runs in CI workflow only');

const THEME_FILE = 'web/src/features/files/model/editorTheme.ts';
const ROOT = '[data-testid="codemirror-editor"]';

interface EditorMetrics {
  tokenFontSize: string;
  tokenLineHeight: string;
  tokenGutterWidth: string;
  tokenPadY: string;
  renderedFontSize: number;
  renderedLineHeight: number;
  renderedPadTop: number;
  renderedGutterMinWidth: number;
  renderedGutterBorderWidth: number;
}

function violation(rule: string, expected: string, actual: string): string {
  return [
    'DESIGN_SYSTEM_VIOLATION',
    'boundary: codemirror',
    `rule: ${rule}`,
    `file: ${THEME_FILE}`,
    `expected: ${expected}`,
    `actual: ${actual}`,
    `owner: ${THEME_FILE}`,
    'repair: the token did not reach the rendered result — move the decision into',
    '        EditorView.theme; a utility class loses to CodeMirror\'s injected theme.',
  ].join('\n');
}

function px(value: number): number {
  return Math.round(Number.parseFloat(String(value)) * 100) / 100;
}

test.describe('third-party renderer boundary (CodeMirror)', () => {
  // The same viewport fixture-visual.spec.ts opens the Workspace at, so the
  // tree-then-editor path this shares with it is exercised under identical
  // conditions rather than under Playwright's default.
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the rendered editor takes its metrics from the design tokens', async ({ page }) => {
    await gotoFixtureWorkspace(page);
    await openFixtureFile(page);

    const metrics = await page.evaluate((root): EditorMetrics | null => {
      const editor = document.querySelector(root);
      const scroller = editor?.querySelector('.cm-scroller');
      const content = editor?.querySelector('.cm-content');
      const gutters = editor?.querySelector('.cm-gutters');
      const lineNumber = editor?.querySelector('.cm-lineNumbers .cm-gutterElement');
      if (!scroller || !content || !gutters || !lineNumber) {
        return null;
      }
      const rootStyle = getComputedStyle(document.documentElement);
      const scrollerStyle = getComputedStyle(scroller);
      return {
        tokenFontSize: rootStyle.getPropertyValue('--workspace-editor-font-size').trim(),
        tokenLineHeight: rootStyle.getPropertyValue('--workspace-editor-line-height').trim(),
        tokenGutterWidth: rootStyle.getPropertyValue('--workspace-editor-gutter-width').trim(),
        tokenPadY: rootStyle.getPropertyValue('--workspace-editor-pad-y').trim(),
        renderedFontSize: Number.parseFloat(scrollerStyle.fontSize),
        renderedLineHeight: Number.parseFloat(scrollerStyle.lineHeight),
        renderedPadTop: Number.parseFloat(getComputedStyle(content).paddingTop),
        renderedGutterMinWidth: Number.parseFloat(getComputedStyle(lineNumber).minWidth),
        renderedGutterBorderWidth: Number.parseFloat(getComputedStyle(gutters).borderTopWidth),
      };
    }, ROOT);

    // Guard first: the measurement has to be real before it can be trusted.
    expect(
      metrics,
      violation(
        'elements-present',
        'the fixture renders .cm-scroller, .cm-content, .cm-gutters and a line number',
        'one or more of those elements was not in the DOM',
      ),
    ).not.toBeNull();
    const m = metrics as EditorMetrics;

    for (const [name, value] of Object.entries({
      '--workspace-editor-font-size': m.tokenFontSize,
      '--workspace-editor-line-height': m.tokenLineHeight,
      '--workspace-editor-gutter-width': m.tokenGutterWidth,
      '--workspace-editor-pad-y': m.tokenPadY,
    })) {
      expect(value, `${name} resolved to "${value}"`).not.toBe('');
    }

    const expectedLineHeight = px(Number.parseFloat(m.tokenFontSize) * Number.parseFloat(m.tokenLineHeight));
    expect(
      px(m.renderedLineHeight),
      violation(
        'rendered-line-height-matches-token',
        `${expectedLineHeight}px (font-size ${m.tokenFontSize} × line-height ${m.tokenLineHeight})`,
        `${px(m.renderedLineHeight)}px`,
      ),
    ).toBe(expectedLineHeight);

    expect(
      px(m.renderedFontSize),
      violation('rendered-font-size-matches-token', m.tokenFontSize, `${px(m.renderedFontSize)}px`),
    ).toBe(px(Number.parseFloat(m.tokenFontSize)));

    expect(
      px(m.renderedPadTop),
      violation('rendered-padding-matches-token', m.tokenPadY, `${px(m.renderedPadTop)}px`),
    ).toBe(px(Number.parseFloat(m.tokenPadY)));

    expect(
      px(m.renderedGutterMinWidth),
      violation(
        'rendered-gutter-width-matches-token',
        m.tokenGutterWidth,
        `${px(m.renderedGutterMinWidth)}px`,
      ),
    ).toBe(px(Number.parseFloat(m.tokenGutterWidth)));

    // CodeMirror's own theme draws a gutter border; the Nession theme removes
    // it. Its presence is the clearest single sign that the injected theme won.
    expect(
      px(m.renderedGutterBorderWidth),
      violation('gutter-border-removed', '0px border on .cm-gutters', `${px(m.renderedGutterBorderWidth)}px`),
    ).toBe(0);
  });
});

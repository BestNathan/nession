import { githubLight } from '@uiw/codemirror-theme-github';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * The code surface's theme.
 *
 * **Light, always.** This used to follow the wall clock — `githubLight` from
 * 06:00 to 18:00, `githubDark` outside it — so every evening the code editor
 * turned dark inside an otherwise light product. Four separate decisions say the
 * product is light-only: `web/CLAUDE.md` ("Chrome is light-only"), the Boundary
 * system in #747 (all-light, colour reserved for state and action), the terminal
 * (light, and sitting on the same ground as the chrome), and the approved
 * mockup, which draws the editor light. The clock was the one surface
 * disagreeing with all four, and it disagreed silently — the same build looks
 * right before 18:00 and wrong after, so it reads as a rendering glitch rather
 * than as a theme.
 *
 * The GitHub palette itself stays. It is the code surface's own language, and
 * re-expressing it in our tokens is a separate question from which ground it
 * sits on; this change is only the ground.
 */
export const EDITOR_THEME: Extension = githubLight;

/**
 * The mockup's `.editor` / `.ln` metrics: monospace 12px on a 1.75 line box,
 * 14px of vertical padding, and a fixed 34px line-number gutter whose numbers
 * sit right-aligned at 65% opacity so they read as a gutter rather than as
 * content.
 *
 * This is an `EditorView.theme` and not Tailwind arbitrary variants on the
 * wrapper, which is how `.cm-editor` is otherwise styled here. Variants lose:
 * CodeMirror injects its own theme with equal-specificity selectors later in
 * the document, and measured against the running editor, `leading-*`,
 * `min-w-*`, `py-*` and `border-0` were all silently dropped while
 * `opacity-65` survived — a partial application that looks like it worked.
 *
 * `@codemirror/view` is a direct dependency because of this file. It was
 * previously only transitive through `@uiw/react-codemirror`, so importing it
 * here without declaring it would have worked until the hoisting changed.
 */
export const EDITOR_METRICS: Extension = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--workspace-editor-font-size)',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    lineHeight: 'var(--workspace-editor-line-height)',
  },
  '.cm-content': { padding: 'var(--workspace-editor-pad-y) 0' },
  '.cm-gutters': { border: 'none', backgroundColor: 'transparent' },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: 'var(--workspace-editor-gutter-width)',
    padding: '0 var(--workspace-editor-gutter-pad-end) 0 0',
    textAlign: 'right',
    opacity: '0.65',
  },
});

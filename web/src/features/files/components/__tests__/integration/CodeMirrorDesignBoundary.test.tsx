import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CodeMirrorEditor } from '@/features/files/components/CodeMirrorEditor';

describe('CodeMirror design-system boundary', () => {
  it('injects Nession workspace metrics into the renderer-owned stylesheet', async () => {
    render(
      <CodeMirrorEditor
        value={'const answer = 42;\n'}
        filename="answer.ts"
        onChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.cm-editor')).toBeTruthy();
    });

    const injectedCss = [...document.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n');

    // #757 proved that merely putting Tailwind classes on the React wrapper is
    // insufficient: CodeMirror injects later styles and may win the cascade.
    // These assertions inspect the renderer-owned stylesheet produced by
    // EditorView.theme, proving the canonical tokens crossed that boundary.
    expect(injectedCss).toContain('var(--workspace-editor-font-size)');
    expect(injectedCss).toContain('var(--workspace-editor-line-height)');
    expect(injectedCss).toContain('var(--workspace-editor-pad-y)');
    expect(injectedCss).toContain('var(--workspace-editor-gutter-width)');
    expect(injectedCss).toContain('var(--workspace-editor-gutter-pad-end)');
  });
});

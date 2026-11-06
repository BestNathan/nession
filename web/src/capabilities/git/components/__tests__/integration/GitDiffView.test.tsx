import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitDiffView } from '../../GitDiffView';
import type { GitDiffResponse } from '../../../types';

const CHANGED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
].join('\n');

const originalClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientWidth',
);
let clientWidth = 800;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => clientWidth,
  });
});

afterEach(() => {
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  }
});

function response(text: string, overrides: Partial<GitDiffResponse & { state: 'ok' }> = {}) {
  return {
    state: 'ok',
    diff: { path: 'src/a.ts', text, binary: false, truncated_bytes: 0, truncated: false },
    ...overrides,
  } as GitDiffResponse;
}

function patchShadow(): ShadowRoot | null {
  const host = screen.getByTestId('git-diff-patch').querySelector('diffs-container');
  return host?.shadowRoot ?? null;
}

async function renderedLine(type: string): Promise<Element> {
  await waitFor(() => {
    expect(patchShadow()?.querySelector(`[data-line][data-line-type="${type}"]`)).toBeTruthy();
  });
  const line = patchShadow()?.querySelector(`[data-line][data-line-type="${type}"]`);
  if (!line) {
    throw new Error(`expected a ${type} line`);
  }
  return line;
}

describe('GitDiffView', () => {
  it('renders the bounded patch with line numbers and diff line semantics', async () => {
    render(<GitDiffView response={response(CHANGED)} loading={false} error={null} />);

    expect(await renderedLine('context')).toHaveTextContent('const a = 1;');
    expect(await renderedLine('change-deletion')).toHaveTextContent('const b = 2;');
    expect(await renderedLine('change-addition')).toHaveTextContent('const b = 3;');
    expect(patchShadow()?.querySelectorAll('[data-column-number]').length).toBeGreaterThan(0);
    expect(patchShadow()?.querySelector('pre[data-diff]')).toHaveAttribute(
      'data-diff-type',
      'single',
    );
  });

  it('switches unified ↔ split without asking Git for another patch', async () => {
    render(<GitDiffView response={response(CHANGED)} loading={false} error={null} />);
    await renderedLine('change-addition');

    const unified = await screen.findByTestId('git-diff-layout-unified');
    const split = screen.getByTestId('git-diff-layout-split');
    expect(unified).toHaveAttribute('aria-pressed', 'true');

    split.focus();
    expect(document.activeElement).toBe(split);
    await userEvent.keyboard('{Enter}');

    await waitFor(() =>
      expect(patchShadow()?.querySelector('pre[data-diff]')).toHaveAttribute(
        'data-diff-type',
        'split',
      ),
    );
    expect(screen.getByTestId('git-diff-path')).toHaveTextContent('src/a.ts');
    expect(await renderedLine('change-addition')).toHaveTextContent('const b = 3;');

    unified.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(patchShadow()?.querySelector('pre[data-diff]')).toHaveAttribute(
        'data-diff-type',
        'single',
      ),
    );
  });

  it('does not offer a split control the pane cannot use', async () => {
    clientWidth = 400;
    render(<GitDiffView response={response(CHANGED)} loading={false} error={null} />);
    await renderedLine('change-addition');

    expect(screen.queryByTestId('git-diff-layout')).toBeNull();
    expect(patchShadow()?.querySelector('pre[data-diff]')).toHaveAttribute(
      'data-diff-type',
      'single',
    );
    clientWidth = 800;
  });

  it('names each non-patch state instead of leaving an empty pane', async () => {
    const { rerender } = render(
      <GitDiffView response={response('', {
        diff: { path: 'src/empty.txt', text: '', binary: false, truncated_bytes: 0, truncated: false },
      })} loading={false} error={null} />,
    );
    expect(screen.getByTestId('git-diff-no-changes')).toBeVisible();

    rerender(
      <GitDiffView response={response('Binary files differ', {
        diff: { path: 'logo.png', text: '', binary: true, truncated_bytes: 0, truncated: false },
      })} loading={false} error={null} />,
    );
    expect(screen.getByTestId('git-diff-binary')).toBeVisible();
    expect(screen.queryByTestId('git-diff-patch')).toBeNull();

    const modeOnly = [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    rerender(
      <GitDiffView response={response(modeOnly, {
        diff: { path: 'run.sh', text: modeOnly, binary: false, truncated_bytes: 0, truncated: false },
      })} loading={false} error={null} />,
    );
    expect(screen.getByTestId('git-diff-mode-only')).toHaveTextContent('100644');
    expect(screen.getByTestId('git-diff-mode-only')).toHaveTextContent('100755');
    expect(screen.queryByTestId('git-diff-patch')).toBeNull();
  });

  it('falls back to the raw patch when the renderer rejects it', () => {
    const malformed = [
      'diff --git a/src/cut.ts b/src/cut.ts',
      'index 1111111..2222222 100644',
      '--- a/src/cut.ts',
      '+++ b/src/cut.ts',
      '@@ -1,2 +1,2 @@',
      '-const before = 1;',
      '+const after = 2;',
    ].join('\n');

    render(<GitDiffView response={response(malformed)} loading={false} error={null} />);

    expect(screen.getByTestId('git-diff-fallback')).toBeVisible();
    expect(screen.getByTestId('git-diff-fallback-note')).toHaveTextContent(
      'Could not render this diff. Showing the raw patch.',
    );
    expect(screen.getByTestId('git-diff-raw')).toHaveTextContent('@@ -1,2 +1,2 @@');
    expect(screen.getByTestId('git-diff-raw')).toHaveTextContent('+const after = 2;');
    expect(screen.queryByTestId('git-diff-patch')).toBeNull();
  });

  it('always discloses truncation, including while the patch still renders', async () => {
    render(
      <GitDiffView
        response={response(CHANGED, {
          diff: {
            path: 'src/a.ts',
            text: CHANGED,
            binary: false,
            truncated_bytes: 4096,
            truncated: true,
          },
        })}
        loading={false}
        error={null}
      />,
    );

    expect(screen.getByTestId('git-diff-truncated')).toHaveTextContent('4.0 KB');
    await renderedLine('change-addition');
  });
});

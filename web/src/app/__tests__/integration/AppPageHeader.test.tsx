import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppPageHeader } from '@/app/patterns/AppPageHeader';

/**
 * The App title role, spelled out rather than imported from the component: an
 * assertion that read the component's own constant would follow any edit to it,
 * and the point is to pin the custom property the title depends on. App-scoped
 * in name because `--typography-title-size` is emitted only under
 * `[data-experience="app"]` (`nession/no-cross-experience-token`).
 */
const AppTitleRoleClass = 'text-[length:var(--nession-typography-title-size)]';

describe('AppPageHeader', () => {
  it('renders one back affordance and the page title', () => {
    render(<AppPageHeader backLabel="Back to terminal" onBack={vi.fn()} title="Files" />);
    expect(screen.getByTestId('app-page-header')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Files');
    expect(screen.getByTestId('app-page-back')).toBeInTheDocument();
  });

  it('names the depth Back goes to, and only that', () => {
    // #1051: one leave per depth, and it says where it lands. A label of
    // "Back" alone is what let a capability sub-header and a viewer close button
    // both claim the same meaning.
    render(<AppPageHeader backLabel="Back to Files" onBack={vi.fn()} title="web/src/App.tsx" />);
    const back = screen.getByTestId('app-page-back');
    expect(back).toHaveAccessibleName('Back to Files');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('sets a product title in the product face', () => {
    // #1050 stage 4: a capability's name is the page title — not a path or an
    // identifier. The path inside the tool keeps its mono.
    render(<AppPageHeader backLabel="Back to terminal" onBack={vi.fn()} title="Files" />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.className).not.toMatch(/font-mono/);
  });

  it('sets a technical title in mono at the same role', () => {
    // #1051 criterion 11, via visual-language.md's `code` role: the pushed
    // detail's own title is the title role *in mono*. Family and size are
    // independent, so a path is not a smaller string (#1073).
    render(<AppPageHeader backLabel="Back to Files" onBack={vi.fn()} title="web/src/App.tsx" technical />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.className).toMatch(/font-mono/);
    expect(title.className).toContain(AppTitleRoleClass);
  });

  it('sets the title at the App title role, not a Tailwind size', () => {
    // #1073: both depths' titles state the same role. `text-sm` was a primitive
    // default doing a title's job, which left the App's page title smaller than
    // the Session title behind it and at the same size as a file row.
    render(<AppPageHeader backLabel="Back to terminal" onBack={vi.fn()} title="Files" />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.className).toContain(AppTitleRoleClass);
    expect(title.className).not.toMatch(/(^|\s)text-(?:xs|sm|base)(\s|$)/);
  });

  it('fires onBack from the ← button', async () => {
    const onBack = vi.fn();
    render(<AppPageHeader backLabel="Back to terminal" onBack={onBack} title="Files" />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('app-page-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('renders capability action semantics as host icons, never as a second bar', async () => {
    // #3971: the capability contributes meaning; the host owns the glyph,
    // geometry, touch target and overflow. One header per depth still.
    const onActivate = vi.fn();
    render(
      <AppPageHeader
        backLabel="Back to terminal"
        onBack={vi.fn()}
        title="Claude Code"
        actions={[
          {
            id: 'browse',
            label: 'Browse',
            ariaLabel: 'Browse Claude',
            icon: 'browse',
            priority: true,
            onActivate,
          },
        ]}
      />,
    );
    expect(screen.getAllByTestId('app-page-header')).toHaveLength(1);
    const action = screen.getByTestId('app-page-action-browse');
    expect(action).toHaveAccessibleName('Browse Claude');
    const user = userEvent.setup();
    await user.click(action);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('shows a truthful secondary line and opens the Stack Sheet from it', async () => {
    const onJumpToAncestor = vi.fn();
    render(
      <AppPageHeader
        backLabel="Back to Transcripts"
        onBack={vi.fn()}
        title="Raw record"
        subtitle="Claude Code / Transcripts / Transcript"
        ancestors={[
          { id: 'transcript:t1', title: 'Focused transcript' },
          { id: 'transcripts', title: 'Transcripts' },
          { id: 'claude-root', title: 'Claude Code' },
        ]}
        onJumpToAncestor={onJumpToAncestor}
      />,
    );
    expect(screen.getByTestId('app-page-subtitle-text')).toHaveTextContent(
      'Claude Code / Transcripts / Transcript',
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('app-page-subtitle'));
    expect(screen.getByTestId('app-stack-sheet')).toBeInTheDocument();
    await user.click(screen.getByTestId('app-stack-ancestor-transcripts'));
    expect(onJumpToAncestor).toHaveBeenCalledWith('transcripts');
  });

  it('moves extra and destructive actions into More with readable text', async () => {
    const onRefresh = vi.fn();
    const onDelete = vi.fn();
    render(
      <AppPageHeader
        backLabel="Back to terminal"
        onBack={vi.fn()}
        title="MCP server"
        actions={[
          { id: 'browse', label: 'Browse', icon: 'browse', priority: true, onActivate: vi.fn() },
          { id: 'copy', label: 'Copy reference', icon: 'copy', priority: true, onActivate: vi.fn() },
          { id: 'refresh', label: 'Refresh', icon: 'refresh', onActivate: onRefresh },
          { id: 'delete', label: 'Remove server', icon: 'delete', destructive: true, onActivate: onDelete },
        ]}
      />,
    );
    expect(screen.getByTestId('app-page-action-browse')).toBeInTheDocument();
    expect(screen.getByTestId('app-page-action-copy')).toBeInTheDocument();
    // Exactly two compact icons; everything else is overflow.
    expect(screen.queryByTestId('app-page-action-refresh')).toBeNull();
    expect(screen.queryByTestId('app-page-action-delete')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('app-page-more'));
    const refresh = await screen.findByTestId('app-page-action-refresh');
    expect(refresh).toHaveTextContent('Refresh');
    const remove = screen.getByTestId('app-page-action-delete');
    expect(remove).toHaveTextContent('Remove server');
    await user.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

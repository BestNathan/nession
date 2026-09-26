import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppToolHeader } from '@/app/patterns/AppToolHeader';

/**
 * The App title role, spelled out rather than imported from the component: an
 * assertion that read the component's own constant would follow any edit to it,
 * and the point is to pin the custom property the title depends on. App-scoped
 * in name because `--typography-title-size` is emitted only under
 * `[data-experience="app"]` (`nession/no-cross-experience-token`).
 */
const AppTitleRoleClass = 'text-[length:var(--typography-title-size)]';

describe('AppToolHeader', () => {
  it('renders back affordance and the tool label', () => {
    render(<AppToolHeader toolLabel="Files" onBack={vi.fn()} />);
    expect(screen.getByTestId('app-tool-header')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('app-tool-back')).toBeInTheDocument();
  });

  it('sets the tool name in the product face', () => {
    // #1050 stage 4: this heading is the page title — a capability's name, not a
    // path or an identifier. The path inside the tool keeps its mono.
    render(<AppToolHeader toolLabel="Files" onBack={vi.fn()} />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('Files');
    expect(title.className).not.toMatch(/font-mono/);
  });

  it('sets the tool name at the App title role, not a Tailwind size', () => {
    // #1073: the capability title is the page's title — the same role the
    // Session header states. It used to be `text-sm`, a primitive default doing
    // a title's job, which left the App's page title smaller than the Session
    // title behind it and at the same size as a file row.
    render(<AppToolHeader toolLabel="Files" onBack={vi.fn()} />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.className).toContain(AppTitleRoleClass);
    expect(title.className).not.toMatch(/(^|\s)text-(?:xs|sm|base)(\s|$)/);
  });

  it('fires onBack from the ← button', async () => {
    const onBack = vi.fn();
    render(<AppToolHeader toolLabel="Files" onBack={onBack} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('app-tool-back'));
    expect(onBack).toHaveBeenCalled();
  });
});

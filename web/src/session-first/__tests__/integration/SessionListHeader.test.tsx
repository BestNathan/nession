import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionListHeader } from '@/session-first/patterns/SessionListHeader';

const baseProps = {
  searchQuery: '',
  setSearchQuery: vi.fn(),
  statusFilter: 'all' as const,
  setStatusFilter: vi.fn(),
  onlineCount: 1,
  offlineCount: 0,
  onCreate: vi.fn(),
  createDisabled: false,
  onRefresh: vi.fn(),
  loadingSessions: false,
};

describe('SessionListHeader', () => {
  it('renders search, create, and refresh controls', async () => {
    const onCreate = vi.fn();
    const onRefresh = vi.fn();
    render(
      <SessionListHeader
        {...baseProps}
        onCreate={onCreate}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByPlaceholderText('Search agents and sessions...')).toBeInTheDocument();
    expect(screen.getByTestId('session-first-create')).toBeEnabled();

    await userEvent.click(screen.getByTestId('session-first-create'));
    expect(onCreate).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables create when no online agents', () => {
    render(
      <SessionListHeader
        {...baseProps}
        onlineCount={0}
        createDisabled
      />,
    );
    expect(screen.getByTestId('session-first-create')).toBeDisabled();
  });

  it('keeps search visible and hides filters until disclosure opens', async () => {
    render(
      <SessionListHeader
        {...baseProps}
        toggleSort={vi.fn()}
        sortField="name"
        sortDirection="asc"
      />,
    );
    expect(screen.getByPlaceholderText('Search agents and sessions...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Online' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('session-list-filters'));
    expect(await screen.findByRole('button', { name: /Online/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Name/ })).toBeInTheDocument();
  });

  it('uses larger create control under max-lg', () => {
    render(<SessionListHeader {...baseProps} />);
    expect(screen.getByTestId('session-first-create').className).toMatch(/max-lg:min-h-11/);
  });

  it('uses design tokens for root spacing and create transition', () => {
    const { container } = render(<SessionListHeader {...baseProps} />);
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root!.className).toMatch(/shell-space|var\(--shell-space/);
    expect(screen.getByTestId('session-first-create').className).toMatch(
      /duration-\[var\(--motion-shell-duration\)\]/,
    );
  });
});

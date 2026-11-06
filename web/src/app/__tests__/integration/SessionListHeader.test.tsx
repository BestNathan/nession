import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionListHeader } from '@/app/patterns/SessionListHeader';

const baseProps = {
  searchQuery: '',
  setSearchQuery: vi.fn(),
  statusFilter: 'all' as const,
  setStatusFilter: vi.fn(),
  onlineCount: 1,
  offlineCount: 0,
  onRefresh: vi.fn(),
  loadingSessions: false,
};

describe('SessionListHeader', () => {
  it('keeps search visible and puts filters, sort and refresh behind one disclosure', async () => {
    const onRefresh = vi.fn();
    render(
      <SessionListHeader
        {...baseProps}
        toggleSort={vi.fn()}
        sortField="name"
        sortDirection="asc"
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByPlaceholderText('Search sessions...')).toBeInTheDocument();
    expect(screen.getByLabelText('Search sessions')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Online/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh sessions' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('session-list-filters'));
    expect(await screen.findByRole('button', { name: /Online/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Name/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps an applied status filter visible as a removable chip', async () => {
    const setStatusFilter = vi.fn();
    render(
      <SessionListHeader
        {...baseProps}
        statusFilter="offline"
        setStatusFilter={setStatusFilter}
      />,
    );

    const chip = screen.getByTestId('session-list-filter-chip');
    expect(chip).toHaveTextContent('Offline');
    await userEvent.click(chip);
    expect(setStatusFilter).toHaveBeenCalledWith('all');
  });

  it('uses the large control band for the search field and token spacing', () => {
    const { container } = render(<SessionListHeader {...baseProps} />);
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root!.className).toMatch(/var\(--nession-shell-space/);
    expect(screen.getByLabelText('Search sessions').className).toMatch(
      /control-lg/,
    );
    expect(screen.getByLabelText('Search sessions').className).toMatch(
      /radius-control/,
    );
  });
});

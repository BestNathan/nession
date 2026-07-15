import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchBar } from '../SearchBar';

describe('SearchBar', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders search input and all 3 toggle buttons', () => {
    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={3}
        offlineCount={5}
      />,
    );

    expect(screen.getByPlaceholderText('Search agents and sessions...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Online/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Offline/ })).toBeInTheDocument();
  });

  it('calls setSearchQuery after 200ms debounce', () => {
    vi.useFakeTimers();
    const setSearchQuery = vi.fn();

    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={setSearchQuery}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    const input = screen.getByPlaceholderText('Search agents and sessions...');
    fireEvent.change(input, { target: { value: 'dev' } });

    // Should not have been called yet
    expect(setSearchQuery).not.toHaveBeenCalled();

    // Advance time past the debounce threshold
    act(() => { vi.advanceTimersByTime(250); });

    expect(setSearchQuery).toHaveBeenCalledWith('dev');
  });

  it('does NOT call setSearchQuery before debounce expires', () => {
    vi.useFakeTimers();
    const setSearchQuery = vi.fn();

    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={setSearchQuery}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    const input = screen.getByPlaceholderText('Search agents and sessions...');
    fireEvent.change(input, { target: { value: 'dev' } });

    // Advance time only 100ms — before the 200ms debounce
    act(() => { vi.advanceTimersByTime(100); });

    expect(setSearchQuery).not.toHaveBeenCalled();
  });

  it('calls setStatusFilter("online") when online toggle is clicked', async () => {
    const user = userEvent.setup();
    const setStatusFilter = vi.fn();

    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={setStatusFilter}
        onlineCount={3}
        offlineCount={5}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Online/ }));
    expect(setStatusFilter).toHaveBeenCalledWith('online');
  });

  it('calls setStatusFilter("offline") when offline toggle is clicked', async () => {
    const user = userEvent.setup();
    const setStatusFilter = vi.fn();

    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={setStatusFilter}
        onlineCount={3}
        offlineCount={5}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Offline/ }));
    expect(setStatusFilter).toHaveBeenCalledWith('offline');
  });

  it('active toggle button has default variant (not outline)', () => {
    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="online"
        setStatusFilter={vi.fn()}
        onlineCount={3}
        offlineCount={5}
      />,
    );

    const onlineButton = screen.getByRole('button', { name: /Online/ });
    const allButton = screen.getByRole('button', { name: /All/ });

    // Active (online) button gets default variant: bg-primary
    expect(onlineButton.className).toContain('bg-primary');
    // Inactive (all) button gets outline variant: border-input
    expect(allButton.className).toContain('border-input');
  });

  it('input value reflects searchQuery prop', () => {
    render(
      <SearchBar
        searchQuery="test query"
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    const input = screen.getByPlaceholderText('Search agents and sessions...') as HTMLInputElement;
    expect(input.value).toBe('test query');
  });

  it('shows online and offline counts in toggle badges', () => {
    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={3}
        offlineCount={5}
      />,
    );

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('external searchQuery change clears pending debounce', () => {
    vi.useFakeTimers();
    const setSearchQuery = vi.fn();

    const { rerender } = render(
      <SearchBar
        searchQuery=""
        setSearchQuery={setSearchQuery}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    const input = screen.getByPlaceholderText('Search agents and sessions...');
    fireEvent.change(input, { target: { value: 'abort-me' } });

    // Before debounce fires, parent updates searchQuery externally
    rerender(
      <SearchBar
        searchQuery="external-value"
        setSearchQuery={setSearchQuery}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    // Advance past debounce — the pending debounce should have been cancelled
    act(() => { vi.advanceTimersByTime(250); });

    // setSearchQuery should NOT have been called because the debounce was cleared
    expect(setSearchQuery).not.toHaveBeenCalled();
    // The input should reflect the external value
    expect((input as HTMLInputElement).value).toBe('external-value');
  });

  it('rapid typing cancels previous debounce', () => {
    vi.useFakeTimers();
    const setSearchQuery = vi.fn();

    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={setSearchQuery}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={0}
        offlineCount={0}
      />,
    );

    const input = screen.getByPlaceholderText('Search agents and sessions...');

    // First keystroke
    fireEvent.change(input, { target: { value: 'a' } });
    act(() => { vi.advanceTimersByTime(100); });

    // Second keystroke before first debounce fires
    fireEvent.change(input, { target: { value: 'ab' } });
    act(() => { vi.advanceTimersByTime(100); });

    // Only 100ms after second keystroke — still not enough
    expect(setSearchQuery).not.toHaveBeenCalled();

    // Advance past debounce from second keystroke
    act(() => { vi.advanceTimersByTime(150); });

    // Only the last value should be sent
    expect(setSearchQuery).toHaveBeenCalledTimes(1);
    expect(setSearchQuery).toHaveBeenCalledWith('ab');
  });

  it('wraps the filter buttons in a horizontally scrollable container on mobile', () => {
    const { container } = render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={1}
        offlineCount={2}
      />,
    );
    const scroller = container.querySelector('[data-testid="filter-row"]');
    expect(scroller).not.toBeNull();
    expect(scroller?.className).toContain('overflow-x-auto');
  });

  it('gives filter buttons a 44px touch target on mobile', () => {
    render(
      <SearchBar
        searchQuery=""
        setSearchQuery={vi.fn()}
        statusFilter="all"
        setStatusFilter={vi.fn()}
        onlineCount={1}
        offlineCount={2}
      />,
    );
    const all = screen.getByRole('button', { name: /All/ });
    expect(all.className).toContain('min-h-11');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentSection } from '../Dashboard';

describe('AgentSection (mobile collapse)', () => {
  const baseProps = {
    loadingAgents: false,
    agents: [],
    filteredAgents: [],
    isSearchActive: false,
    setSelectedAgent: vi.fn(),
    onlineCount: 3,
    offlineCount: 1,
  };

  it('renders a summary bar with online/offline counts', () => {
    render(<AgentSection {...baseProps} />);
    const bar = screen.getByTestId('agent-summary-bar');
    expect(bar).toHaveTextContent('3 online');
    expect(bar).toHaveTextContent('1 offline');
    expect(bar).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles aria-expanded when the summary bar is tapped', () => {
    render(<AgentSection {...baseProps} />);
    const bar = screen.getByTestId('agent-summary-bar');
    fireEvent.click(bar);
    expect(bar).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(bar);
    expect(bar).toHaveAttribute('aria-expanded', 'false');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleGhostInput } from '@/session-first/capsule/CapsuleGhostInput';

vi.mock('@/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    history: [{ id: '1', command: 'aaa --verbose', timestamp: 1 }],
    addEntry: vi.fn(),
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn(),
  }),
}));

describe('CapsuleGhostInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders input and shows ghost suffix for prefix match', () => {
    render(
      <CapsuleGhostInput value="aaa" onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('capsule-ghost-input')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-ghost-suffix').textContent).toContain('--verbose');
  });

  it('accepts ghost suffix on Tab', async () => {
    const onChange = vi.fn();
    render(<CapsuleGhostInput value="aaa" onChange={onChange} />);
    const textarea = screen.getByTestId('capsule-ghost-input');
    textarea.focus();
    await userEvent.keyboard('{Tab}');
    expect(onChange).toHaveBeenCalledWith('aaa --verbose');
  });

  it('hides ghost while composing', () => {
    render(<CapsuleGhostInput value="aaa" onChange={vi.fn()} />);
    const textarea = screen.getByTestId('capsule-ghost-input');
    fireEvent.compositionStart(textarea);
    expect(screen.queryByTestId('capsule-ghost-suffix')).not.toBeInTheDocument();
  });
});

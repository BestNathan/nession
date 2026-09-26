import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppToolHeader } from '@/app/patterns/AppToolHeader';

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

  it('fires onBack from the ← button', async () => {
    const onBack = vi.fn();
    render(<AppToolHeader toolLabel="Files" onBack={onBack} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('app-tool-back'));
    expect(onBack).toHaveBeenCalled();
  });
});

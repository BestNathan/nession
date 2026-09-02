import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppToolHeader } from '@/session-first/patterns/AppToolHeader';

describe('AppToolHeader', () => {
  it('renders back affordance and the tool label', () => {
    render(<AppToolHeader toolLabel="Files" onBack={vi.fn()} />);
    expect(screen.getByTestId('app-tool-header')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('app-tool-back')).toBeInTheDocument();
  });

  it('fires onBack from the ← button', async () => {
    const onBack = vi.fn();
    render(<AppToolHeader toolLabel="Files" onBack={onBack} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('app-tool-back'));
    expect(onBack).toHaveBeenCalled();
  });
});

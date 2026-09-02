import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToolHeader } from '@/session-first/patterns/AppToolHeader';

describe('AppToolHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders back affordance and the tool label', () => {
    render(<AppToolHeader toolLabel="Files" onBack={vi.fn()} />);
    expect(screen.getByTestId('app-tool-header')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByTestId('app-tool-back')).toBeInTheDocument();
  });

  it('fires onBack from the ← button', async () => {
    const onBack = vi.fn();
    render(<AppToolHeader toolLabel="Files" onBack={onBack} />);
    const user = (await import('@testing-library/user-event')).default;
    await user.click(screen.getByTestId('app-tool-back'));
    expect(onBack).toHaveBeenCalled();
  });
});

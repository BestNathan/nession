import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FixtureWorkspace } from '@/session-first/fixture/FixtureWorkspace';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('FixtureWorkspace', () => {
  it('renders the workspace shell with the tool bar and files layout', () => {
    render(<FixtureWorkspace />);
    expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-tool-bar')).toBeInTheDocument();
    expect(screen.getByTestId('files-web-layout')).toBeInTheDocument();
  });

  it('renders the registry tabs', () => {
    render(<FixtureWorkspace />);
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Session' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agent' })).toBeInTheDocument();
  });
});

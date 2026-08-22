import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionPreviewDialog } from '@/components/SessionPreviewDialog';
import { useSessionPreview } from '@/hooks/useSessionPreview';

vi.mock('@/hooks/useSessionPreview');
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    options: {},
  })),
}));
vi.mock('@xterm/addon-canvas', () => ({ CanvasAddon: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })) }));

// Mock Dialog to render children directly (no portal)
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('SessionPreviewDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSessionPreview).mockReturnValue({
      status: 'idle',
      ansi: '',
      cols: undefined,
      rows: undefined,
      error: null,
      capture: vi.fn(),
      reset: vi.fn(),
    });
  });

  it('renders with lines input defaulting to 2000', () => {
    render(
      <SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="test" />,
    );
    expect(screen.getByLabelText(/lines/i)).toHaveValue(2000);
  });

  it('shows skeleton while loading', () => {
    vi.mocked(useSessionPreview).mockReturnValue({
      status: 'loading',
      ansi: '',
      cols: undefined,
      rows: undefined,
      error: null,
      capture: vi.fn(),
      reset: vi.fn(),
    });
    render(
      <SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="test" />,
    );
    // Skeleton renders with data-slot="skeleton"
    const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows error state with retry', () => {
    vi.mocked(useSessionPreview).mockReturnValue({
      status: 'error',
      ansi: '',
      cols: undefined,
      rows: undefined,
      error: 'tmux failed',
      capture: vi.fn(),
      reset: vi.fn(),
    });
    render(
      <SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="test" />,
    );
    expect(screen.getByText('tmux failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('calls capture on refresh', () => {
    const capture = vi.fn();
    vi.mocked(useSessionPreview).mockReturnValue({
      status: 'idle',
      ansi: '',
      cols: undefined,
      rows: undefined,
      error: null,
      capture,
      reset: vi.fn(),
    });
    render(
      <SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="test" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(capture).toHaveBeenCalledWith('a:b', 2000);
  });

  it('renders title with session name', () => {
    render(
      <SessionPreviewDialog isOpen onClose={() => {}} sessionId="a:b" sessionName="my-session" />,
    );
    expect(screen.getByText(/my-session/)).toBeInTheDocument();
  });
});

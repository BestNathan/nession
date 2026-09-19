import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityProjection } from '../../CapabilityProjection';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';

function projection(
  overrides: Partial<CapsuleCapabilityProjection> = {},
): CapsuleCapabilityProjection {
  return {
    id: 'git',
    title: 'Git',
    depth: 'signal',
    body: () => <p data-testid="body">body content</p>,
    onDeeper: vi.fn(),
    onDismiss: vi.fn(),
    onOpenWorkspace: vi.fn(),
    ...overrides,
  };
}

describe('capability projection frame', () => {
  it('names the capability from what it was given, not from the body', () => {
    render(<CapabilityProjection projection={projection()} />);

    expect(screen.getByTestId('capsule-capability-title')).toHaveTextContent('Git');
  });

  it('carries the depth it was given as data', () => {
    // Depth is decided before this mounts; the frame only reports which one it
    // is showing, so a styling or test question can be asked of the DOM.
    const { rerender } = render(<CapabilityProjection projection={projection()} />);
    expect(screen.getByTestId('capsule-capability-projection')).toHaveAttribute(
      'data-depth',
      'signal',
    );

    rerender(<CapabilityProjection projection={projection({ depth: 'peek' })} />);
    expect(screen.getByTestId('capsule-capability-projection')).toHaveAttribute(
      'data-depth',
      'peek',
    );
  });

  it('opens a Signal deeper from its title', async () => {
    const onDeeper = vi.fn();
    render(<CapabilityProjection projection={projection({ onDeeper })} />);

    await userEvent.click(screen.getByTestId('capsule-capability-title'));

    expect(onDeeper).toHaveBeenCalledTimes(1);
  });

  it('offers no deeper step once it is already a Peek', async () => {
    // Peek is as deep as the Terminal goes; going further is the Workspace, and
    // that is a different affordance with a different consequence.
    const onDeeper = vi.fn();
    render(<CapabilityProjection projection={projection({ depth: 'peek', onDeeper })} />);

    const title = screen.getByTestId('capsule-capability-title');
    expect(title).toBeDisabled();
    await userEvent.click(title);
    expect(onDeeper).not.toHaveBeenCalled();
  });

  it('offers the Workspace only from a Peek, when a Peek is what comes next', async () => {
    const { rerender } = render(<CapabilityProjection projection={projection()} />);
    expect(screen.queryByTestId('capsule-capability-open-workspace')).toBeNull();

    rerender(<CapabilityProjection projection={projection({ depth: 'peek' })} />);
    expect(screen.getByTestId('capsule-capability-open-workspace')).toBeInTheDocument();
  });

  it('reaches the Workspace from the Signal when there is no Peek', async () => {
    // Claude Code's shape: it has one Terminal depth, so hiding the way in
    // behind a step that does not exist would leave the Workspace unreachable
    // from the Terminal entirely.
    const onOpenWorkspace = vi.fn();
    render(
      <CapabilityProjection projection={projection({ onDeeper: undefined, onOpenWorkspace })} />,
    );

    expect(screen.getByTestId('capsule-capability-title')).toBeDisabled();
    await userEvent.click(screen.getByTestId('capsule-capability-open-workspace'));

    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
  });

  it('makes the title inert rather than opening an empty Peek', async () => {
    const onOpenWorkspace = vi.fn();
    render(
      <CapabilityProjection projection={projection({ onDeeper: undefined, onOpenWorkspace })} />,
    );

    const title = screen.getByTestId('capsule-capability-title');
    expect(title).toBeDisabled();
    await userEvent.click(title);

    // Nothing deeper happened — no Workspace either, since that is a separate
    // decision the user makes with a control that says so.
    expect(onOpenWorkspace).not.toHaveBeenCalled();
  });

  it('still dismisses a Signal with no Peek', async () => {
    const onDismiss = vi.fn();
    render(
      <CapabilityProjection
        projection={projection({ onDeeper: undefined, onDismiss })}
      />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('carries what the body reported into the Workspace handoff', async () => {
    // The frame owns the selection the body produces: the body says what the
    // user picked, the frame is what knows where it is going.
    const onOpenWorkspace = vi.fn();
    render(
      <CapabilityProjection
        projection={projection({
          depth: 'peek',
          onOpenWorkspace,
          body: (_focus, setFocus) => (
            <button type="button" data-testid="pick" onClick={() => setFocus('src/a.ts')}>
              pick
            </button>
          ),
        })}
      />,
    );

    await userEvent.click(screen.getByTestId('pick'));
    await userEvent.click(screen.getByTestId('capsule-capability-open-workspace'));

    expect(onOpenWorkspace).toHaveBeenCalledWith('src/a.ts');
  });

  it('hands over nothing when the user picked nothing', async () => {
    // Opening the Workspace from a Peek with no selection is the capability
    // landing page, which is a legitimate thing to want.
    const onOpenWorkspace = vi.fn();
    render(
      <CapabilityProjection projection={projection({ depth: 'peek', onOpenWorkspace })} />,
    );

    await userEvent.click(screen.getByTestId('capsule-capability-open-workspace'));

    expect(onOpenWorkspace).toHaveBeenCalledWith(undefined);
  });

  it('dismisses from either depth', async () => {
    const onDismiss = vi.fn();
    render(<CapabilityProjection projection={projection({ depth: 'peek', onDismiss })} />);

    await userEvent.click(screen.getByTestId('capsule-capability-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('labels the dismissal with the capability it dismisses', () => {
    render(<CapabilityProjection projection={projection()} />);

    // An icon-only control still needs a name, and "Dismiss" alone would be
    // useless read out of context.
    expect(screen.getByLabelText('Dismiss Git')).toBeInTheDocument();
  });
});

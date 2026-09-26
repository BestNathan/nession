import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeekHost } from '../../PeekHost';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';

const sendText = vi.fn();

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

/**
 * The frame takes the capsule's transport and hands it to whatever body it
 * draws. Nothing here exercises it — Terminal Keys' own test does that.
 */
function frame(value: CapsuleCapabilityProjection) {
  return <PeekHost projection={value} sendText={sendText} disabled={false} />;
}

function renderFrame(value: CapsuleCapabilityProjection) {
  return render(frame(value));
}

describe('capability projection frame', () => {
  it('names the capability from what it was given, not from the body', () => {
    renderFrame(projection());

    expect(screen.getByTestId('capsule-capability-title')).toHaveTextContent('Git');
  });

  it('carries the depth it was given as data', () => {
    // Depth is decided before this mounts; the frame only reports which one it
    // is showing, so a styling or test question can be asked of the DOM.
    const { rerender } = renderFrame(projection());
    expect(screen.getByTestId('capsule-capability-projection')).toHaveAttribute(
      'data-depth',
      'signal',
    );

    rerender(frame(projection({ depth: 'peek' })));
    expect(screen.getByTestId('capsule-capability-projection')).toHaveAttribute(
      'data-depth',
      'peek',
    );
  });

  it('opens a Signal deeper from its title', async () => {
    const onDeeper = vi.fn();
    renderFrame(projection({ onDeeper }));

    await userEvent.click(screen.getByTestId('capsule-capability-title'));

    expect(onDeeper).toHaveBeenCalledTimes(1);
  });

  it('offers no deeper step once it is already a Peek', async () => {
    // Peek is as deep as the Terminal goes; going further is the Workspace, and
    // that is a different affordance with a different consequence.
    const onDeeper = vi.fn();
    renderFrame(projection({ depth: 'peek', onDeeper }));

    const title = screen.getByTestId('capsule-capability-title');
    expect(title).toBeDisabled();
    await userEvent.click(title);
    expect(onDeeper).not.toHaveBeenCalled();
  });

  it('renders no Workspace action of its own, at either depth', () => {
    // **The inversion (#1046).** The host used to draw this as a footer on every
    // Peek, which made every capability end on the same borrowed sentence, and
    // it decided *for* the capability whether the action existed. It now hands
    // the action to the body; the host drawing one at any depth is the
    // regression this asserts against.
    const { rerender } = renderFrame(projection());
    expect(screen.queryByTestId('capsule-capability-open-workspace')).toBeNull();

    rerender(frame(projection({ depth: 'peek' })));
    expect(screen.queryByTestId('capsule-capability-open-workspace')).toBeNull();
  });

  it('hands the body an action that deepens where the body says', async () => {
    // The capability names the target when it knows one — a file it just listed,
    // a row the user is looking at.
    const onOpenWorkspace = vi.fn();
    renderFrame(
      projection({
        depth: 'peek',
        onOpenWorkspace,
        body: (_focus, _setFocus, actions) => (
          <button
            type="button"
            data-testid="deepen"
            onClick={() => actions.openWorkspace('src/a.ts')}
          >
            open
          </button>
        ),
      }),
    );

    await userEvent.click(screen.getByTestId('deepen'));

    expect(onOpenWorkspace).toHaveBeenCalledWith('src/a.ts');
  });

  it('makes the title inert rather than opening an empty Peek', async () => {
    const onOpenWorkspace = vi.fn();
    renderFrame(projection({ onDeeper: undefined, onOpenWorkspace }));

    const title = screen.getByTestId('capsule-capability-title');
    expect(title).toBeDisabled();
    await userEvent.click(title);

    // Nothing deeper happened — and no Workspace either, since that is a
    // separate decision the user makes with a control that says so.
    expect(onOpenWorkspace).not.toHaveBeenCalled();
  });

  it('keeps a capability with neither a Peek nor a Workspace dismissible', async () => {
    // Terminal Keys' shape: the accessory is the capability in full, so the
    // only way out is the one control it is guaranteed.
    const onDismiss = vi.fn();
    renderFrame(
      projection({ onDeeper: undefined, onOpenWorkspace: undefined, onDismiss }),
    );

    await userEvent.click(screen.getByTestId('capsule-capability-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('deepens at the item the body reported, when the action names none', async () => {
    // The host still owns the selection — that is what makes the transition land
    // on the right thing (#826) — and `openWorkspace()` with no argument uses it,
    // which is what the footer used to do.
    //
    // Two clicks, and that is not incidental: the action closes over the focus as
    // of its render, so a body that picks *and* deepens inside one handler would
    // pass the value from before the pick. That is the real reason a capability
    // with a selection to carry should name it (the test above) rather than rely
    // on the host's.
    const onOpenWorkspace = vi.fn();
    renderFrame(
      projection({
        depth: 'peek',
        onOpenWorkspace,
        body: (_focus, setFocus, actions) => (
          <>
            <button type="button" data-testid="pick" onClick={() => setFocus('src/a.ts')}>
              pick
            </button>
            <button type="button" data-testid="deepen" onClick={() => actions.openWorkspace()}>
              open
            </button>
          </>
        ),
      }),
    );

    await userEvent.click(screen.getByTestId('pick'));
    await userEvent.click(screen.getByTestId('deepen'));

    expect(onOpenWorkspace).toHaveBeenCalledWith('src/a.ts');
  });

  it('hands over nothing when the user picked nothing', async () => {
    // Opening the Workspace from a Peek with no selection is the capability
    // landing page, which is a legitimate thing to want.
    const onOpenWorkspace = vi.fn();
    renderFrame(
      projection({
        depth: 'peek',
        onOpenWorkspace,
        body: (_focus, _setFocus, actions) => (
          <button type="button" data-testid="deepen" onClick={() => actions.openWorkspace()}>
            open
          </button>
        ),
      }),
    );

    await userEvent.click(screen.getByTestId('deepen'));

    expect(onOpenWorkspace).toHaveBeenCalledWith(undefined);
  });

  it('dismisses from either depth', async () => {
    const onDismiss = vi.fn();
    renderFrame(projection({ depth: 'peek', onDismiss }));

    await userEvent.click(screen.getByTestId('capsule-capability-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('labels the dismissal with the capability it dismisses', () => {
    renderFrame(projection());

    // An icon-only control still needs a name, and "Dismiss" alone would be
    // useless read out of context.
    expect(screen.getByLabelText('Dismiss Git')).toBeInTheDocument();
  });
});

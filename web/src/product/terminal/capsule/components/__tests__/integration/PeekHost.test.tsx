import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeekHost } from '../../PeekHost';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';

const sendText = vi.fn();
/** Renders a semantic key as `semantic:<name>`, the seam both key tests use. */
const sendPhysKey = vi.fn((key: { semanticKey?: string; seq?: string }) => {
  sendText(key.semanticKey ? `semantic:${key.semanticKey}` : key.seq);
});

function projection(
  overrides: Partial<CapsuleCapabilityProjection> = {},
): CapsuleCapabilityProjection {
  return {
    id: 'git',
    title: 'Git',
    body: () => <p data-testid="body">body content</p>,
    onDismiss: vi.fn(),
    onOpenWorkspace: vi.fn(),
    ...overrides,
  };
}

/**
 * The frame takes the capsule's transport and hands it to whatever body it
 * draws. Nothing here exercises it — Terminal Keys' own test does that.
 *
 * Both senders are supplied because that is the shape the real host has:
 * `TerminalSurface` always passes `sendPhysKey`, and the body's fallback to raw
 * bytes exists only for a host that omits it. Leaving it out here made a test
 * about *frame survival* quietly exercise a configuration production cannot
 * reach — and, once the key row stopped carrying sequences of its own (#1096
 * criterion 4), that configuration stopped being able to send anything at all.
 */
function frame(value: CapsuleCapabilityProjection) {
  return (
    <PeekHost projection={value} sendText={sendText} sendPhysKey={sendPhysKey} disabled={false} />
  );
}

function renderFrame(value: CapsuleCapabilityProjection) {
  return render(frame(value));
}

describe('capability projection frame', () => {
  it('names the capability from what it was given, not from the body', () => {
    renderFrame(projection());

    expect(screen.getByTestId('capsule-capability-title')).toHaveTextContent('Git');
  });

  it('names the projection with a title that is not a control', () => {
    // With one depth there is nothing behind the title to open — it used to be
    // the Signal's way in — so it names the projection and takes no input.
    renderFrame(projection());

    const title = screen.getByTestId('capsule-capability-title');
    expect(title.tagName).toBe('H2');
    expect(title).not.toHaveAttribute('role', 'button');
  });

  it('carries the containment boundary that keeps a body inside the host (#1347 SC-27)', () => {
    // Paint containment is what makes the contract's no-portals rule (#1120)
    // more than a request: `position: fixed` in a body resolves against the
    // host instead of the viewport, and a body's z-index stays inside the
    // host's stacking context. jsdom cannot prove the clipping; it can prove
    // the mechanism is on the element every body is drawn into.
    renderFrame(projection());

    expect(screen.getByTestId('capsule-capability-projection').className).toContain(
      'contain-paint',
    );
  });

  it('owns the Workspace destination (#1347 SC-21)', () => {
    // **The re-inversion.** `#1046` handed the action to the body; #1347's
    // "Peek header and Workspace destination are Nession-owned" takes the
    // presentation back, and re-review #2 settled that #1046 is superseded on
    // this point. The body drawing its own "Open in Workspace" is now the
    // regression. Whether the destination exists is the app layer's answer, so
    // the frame draws it whenever the capability supplies one — and never for
    // a capability, like Terminal Keys, that has no Workspace view.
    const { rerender } = renderFrame(projection({ onOpenWorkspace: undefined }));
    expect(screen.queryByTestId('capsule-capability-open-workspace')).toBeNull();

    rerender(frame(projection()));
    expect(screen.getByTestId('capsule-capability-open-workspace')).toBeInTheDocument();
  });

  it('draws no destination for a capability with no Workspace view', () => {
    // Presence is the app layer's answer (the Workspace view registry), so a
    // capability without a view — Terminal Keys — supplies no routing and the
    // host draws nothing.
    renderFrame(projection({ onOpenWorkspace: undefined }));

    expect(screen.queryByTestId('capsule-capability-open-workspace')).toBeNull();
  });

  it('hands the destination the item the body reported', async () => {
    // The host-held focus is what makes the handoff land on the right thing
    // (#826): pick in the body, then the destination carries the pick.
    const onOpenWorkspace = vi.fn();
    renderFrame(
      projection({
        onOpenWorkspace,
        body: (_focus, setFocus) => (
          <button type="button" data-testid="pick" onClick={() => setFocus('src/a.ts')}>
            pick
          </button>
        ),
      }),
    );

    await userEvent.click(screen.getByTestId('pick'));
    await userEvent.click(screen.getByTestId('capsule-capability-open-workspace'));

    expect(onOpenWorkspace).toHaveBeenCalledWith('src/a.ts');
  });

  it('the destination with no selection opens the capability landing page', async () => {
    const onOpenWorkspace = vi.fn();
    renderFrame(projection({ onOpenWorkspace }));

    await userEvent.click(screen.getByTestId('capsule-capability-open-workspace'));

    expect(onOpenWorkspace).toHaveBeenCalledWith(undefined);
  });

  it('hands the body an action that deepens where the body says', async () => {
    // The capability names the target when it knows one — a file it just listed,
    // a row the user is looking at.
    const onOpenWorkspace = vi.fn();
    renderFrame(
      projection({
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

  it('keeps the close hit target separate from its drawn affordance (#1446 SC-08)', () => {
    renderFrame(projection());

    const dismiss = screen.getByTestId('capsule-capability-dismiss');
    const visual = dismiss.querySelector('[data-testid="capsule-control-visual"]');
    expect(dismiss.className).toContain('var(--nession-control-md)');
    expect(visual).not.toBeNull();
    expect(visual?.className).toContain('var(--nession-control-visual-size)');
  });

  it('typesets Nession-owned Peek chrome with canonical roles without leaking them into the body', () => {
    renderFrame(projection());

    expect(screen.getByTestId('capsule-capability-title').className).toContain(
      'var(--nession-typography-body-size)',
    );
    expect(screen.getByTestId('capsule-capability-title').className).not.toContain(
      'terminal-capsule-projection-font-size',
    );
    expect(screen.getByTestId('capsule-capability-open-workspace').className).toContain(
      'var(--nession-typography-body-size)',
    );

    // The host owns title/actions, not the capability body's inherited type
    // context. Putting a role on the root makes a new capability silently pick
    // up Nession host typography even when its own controls have different
    // workload semantics (Terminal Keys exposed this in #1446 visual review).
    expect(screen.getByTestId('capsule-capability-projection').className).not.toContain(
      'var(--nession-typography-body-size)',
    );
  });

  it('keeps a capability with no Workspace destination dismissible', async () => {
    // Terminal Keys' shape: the accessory is the capability in full, so the
    // only way out is the one control it is guaranteed.
    const onDismiss = vi.fn();
    renderFrame(projection({ onOpenWorkspace: undefined, onDismiss }));

    await userEvent.click(screen.getByTestId('capsule-capability-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('deepens at the item the body reported, when the action names none', async () => {
    // The host still owns the selection — that is what makes the transition land
    // on the right thing (#826) — and `openWorkspace()` with no argument uses it,
    // which is also what the host's own destination action does.
    //
    // Two clicks, and that is not incidental: the action closes over the focus as
    // of its render, so a body that picks *and* deepens inside one handler would
    // pass the value from before the pick. That is the real reason a capability
    // with a selection to carry should name it (the test above) rather than rely
    // on the host's.
    const onOpenWorkspace = vi.fn();
    renderFrame(
      projection({
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

  it('dismisses the projection', async () => {
    const onDismiss = vi.fn();
    renderFrame(projection({ onDismiss }));

    await userEvent.click(screen.getByTestId('capsule-capability-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('labels the dismissal with the capability it dismisses', () => {
    renderFrame(projection());

    // An icon-only control still needs a name, and "Dismiss" alone would be
    // useless read out of context.
    expect(screen.getByLabelText('Dismiss Git')).toBeInTheDocument();
  });

  it('opens a body’s detail in the host overlay, and closes it again', async () => {
    // #1120's child overlay: a capability supplies *content*, the host owns the
    // surface. What is asserted here is the split rather than the styling — the
    // body never places anything, and the title it hands over is the overlay's
    // accessible name.
    const user = userEvent.setup();
    const peek = projection({
      body: (_focus, _setFocus, actions) => (
        <button
          type="button"
          data-testid="open-detail"
          onClick={() =>
            actions.openDetail({ title: 'A conversation', content: <p>the transcript</p> })
          }
        >
          open
        </button>
      ),
    });
    renderFrame(peek);

    // Nothing is mounted until it is asked for: the overlay is not a panel that
    // happens to be hidden.
    expect(screen.queryByTestId('capsule-capability-detail')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('open-detail'));

    const overlay = await screen.findByTestId('capsule-capability-detail');
    expect(overlay).toHaveTextContent('A conversation');
    expect(overlay).toHaveTextContent('the transcript');
    // The Peek it came from is still there — the overlay is temporary and does
    // not replace the surface under it.
    expect(screen.getByTestId('capsule-capability-projection')).toBeInTheDocument();
  });

  it('closes the overlay on Escape and gives focus back to what opened it', async () => {
    // #1120: "dismiss returns focus to the action that opened it". Keyboard
    // users otherwise land back at the top of the document with no way to tell
    // where they were.
    const user = userEvent.setup();
    const peek = projection({
      body: (_focus, _setFocus, actions) => (
        <button
          type="button"
          data-testid="open-detail"
          onClick={() => actions.openDetail({ title: 'A conversation', content: <p>x</p> })}
        >
          open
        </button>
      ),
    });
    renderFrame(peek);

    const opener = screen.getByTestId('open-detail');
    await user.click(opener);
    await screen.findByTestId('capsule-capability-detail');

    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByTestId('capsule-capability-detail')).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(opener);
  });

  it('survives switching from a Peek body to Terminal Keys and sending a key', async () => {
    const { terminalKeysProjection } = await import('@/product/terminal/terminalKeys');

    const gitPeek = projection({
      body: () => <p data-testid="git-peek-body">peek</p>,
    });
    const keysPeek: CapsuleCapabilityProjection = {
      id: 'terminal-keys',
      title: 'Terminal Keys',
      ownsInputFocus: true,
      onDismiss: vi.fn(),
      body: (_focus, setFocus, actions) =>
        terminalKeysProjection.body({
          agentId: 'a1',
          sessionId: 's1',
          state: 'available',
          onFocusChange: setFocus,
          ...actions,
        }),
    };

    const { rerender } = renderFrame(gitPeek);
    expect(screen.getByTestId('git-peek-body')).toBeInTheDocument();

    rerender(frame(keysPeek));
    await userEvent.click(screen.getByTestId('phys-key-Esc'));
    // Esc routes through the semantic seam like every other named key in the
    // row (#1096 criterion 4) — the row owns no escape of its own.
    expect(sendText).toHaveBeenCalledWith('semantic:Escape');
  });
});

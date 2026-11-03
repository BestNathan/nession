import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  TerminalSurface,
  type TerminalSurfaceProps,
} from '@/product/terminal/patterns/TerminalSurface';

/**
 * Answers "yes, desktop" — deliberately, and it is load-bearing.
 *
 * `TerminalSurface` must not consult the viewport at all any more, so any
 * media query reintroduced here would be answered `true` and would show up as
 * the *wrong capsule* rather than as a silent 768-vs-1024 disagreement.
 */
vi.mock('@/shared/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
}));

vi.mock('@/product/terminal/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

function renderSurface(
  experience: 'web' | 'app',
  props: Partial<
    Pick<
      TerminalSurfaceProps,
      'inputDrop' | 'onDismissInputDrop' | 'terminalControl' | 'onTakeControl' | 'historyDegraded' | 'streamState' | 'clipboardNotice' | 'onDismissClipboardNotice' | 'controller'
    >
  > = {},
) {
  return render(
    <TerminalSurface
      experience={experience}
      inputDisabled={false}
      controller={null}
      {...props}
    >
      <div data-testid="terminal-viewport-slot" />
    </TerminalSurface>,
  );
}

/** A notice is visible only after explicitly opening its contextual Capsule action. */
function openNotices() {
  fireEvent.click(screen.getByTestId('terminal-notices-trigger'));
}

describe('TerminalSurface', () => {
  it('hosts xterm tree and floating capsule without legacy layout', () => {
    renderSurface('web');

    // One terminal host remains, with no automatic notice layer.
    const surface = screen.getByTestId('terminal-surface');
    const host = surface.querySelector('[data-terminal-capsule-host]');
    expect(host).toHaveAttribute('data-terminal-scrollback-mode', 'local-buffer');
    expect(host).toContainElement(screen.getByTestId('terminal-capsule'));

    expect(screen.getByTestId('terminal-viewport-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-terminal-layout')).not.toBeInTheDocument();
  });

  it('takes the capsule experience from the shell, not from the viewport', () => {
    // Regression (#1049 / #1057). This component used to choose the capsule
    // with its own `useMediaQuery('(min-width: 768px)')` while the shell chose
    // its layout with `(min-width: 1024px)`. Between those widths the App shell
    // drew an App layout around a **Web** capsule — including the permanent
    // history control #1034 retired. iPad portrait and every landscape phone
    // live in that band.
    //
    // The mocked query above returns `true`, so this passes only while the prop
    // is what decides: if a viewport query ever comes back, the `app` render
    // below would produce the web capsule and fail here.
    const app = renderSurface('app');
    expect(screen.queryByTestId('capsule-history-trigger')).toBeNull();
    app.unmount();

    renderSurface('web');
    expect(screen.getByTestId('capsule-history-trigger')).toBeInTheDocument();
  });
});

/**
 * #1307 SC-09 — the one user-visible surface this requirement adds.
 *
 * The requirement's constraint is "quiet by default, present only when a
 * decision is owed". The root overlay is absent, not an empty height reserve.
 */
describe('input that will never arrive (#1307 SC-09)', () => {
  it('says nothing when nothing has been lost', () => {
    renderSurface('web');

    expect(screen.queryByTestId('terminal-input-drop')).toBeNull();
  });

  it('states the uncertainty an epoch change leaves behind', () => {
    // The case the whole state exists for. The agent that could say whether
    // these bytes reached the PTY is gone, and its answer died with it, so the
    // surface says what is unknown rather than a fact it does not have — a
    // user who reads silence here is a user who re-runs a command that may
    // already have run.
    renderSurface('web', { inputDrop: { reason: 'epoch', chunks: 1, at: 0 } });
    expect(screen.queryByTestId('terminal-input-drop')).toBeNull();
    openNotices();

    expect(screen.getByTestId('terminal-input-drop')).toHaveTextContent(
      'Some input may not have reached the session — check before re-running it.',
    );
  });

  it('accounts for the losses the client can explain', () => {
    // The other three are losses the client *can* account for, which is what
    // makes silence the wrong answer for them too — the requirement asks for
    // "discard with explicit UX", not for three more ways to say nothing.
    const explained: Array<[Parameters<typeof renderSurface>[1], string]> = [
      [{ inputDrop: { reason: 'age', chunks: 2, at: 0 } }, 'it waited too long'],
      [{ inputDrop: { reason: 'bound', chunks: 1, at: 0 } }, 'too much was already waiting'],
      [{ inputDrop: { reason: 'generation', chunks: 1, at: 0 } }, 'another client took control'],
    ];

    for (const [props, phrase] of explained) {
      const view = renderSurface('web', props);
      openNotices();
      expect(screen.getByTestId('terminal-input-drop')).toHaveTextContent(phrase);
      view.unmount();
    }
  });

  it('offers the decision and nothing else, and offers it once', async () => {
    // No re-send, and that is the design rather than an omission: the bytes
    // were discarded rather than kept (SC-15 keeps input contents out of
    // durable state) and re-sending input that may already have run is the
    // automatic replay the requirement forbids. So the strip carries exactly
    // one action, and it is the user's own decision to put it away.
    const onDismissInputDrop = vi.fn();
    renderSurface('web', {
      inputDrop: { reason: 'epoch', chunks: 1, at: 0 },
      onDismissInputDrop,
    });
    openNotices();

    const strip = screen.getByTestId('terminal-input-drop');
    const actions = strip.querySelectorAll('button');
    expect(actions).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissInputDrop).toHaveBeenCalledTimes(1);
  });
});

/** Status detail is portaled outside the terminal host only after user activation. */
describe('the capsule host wraps the well, not the surface (#1307 stage 6)', () => {
  function hostOf(view: ReturnType<typeof renderSurface>): HTMLElement {
    const surface = view.getByTestId('terminal-surface');
    // The host *is* the surface in the shape this test exists to reject, so the
    // lookup has to accept both or the assertions below would fail on a null
    // lookup instead of on the containment they are about.
    const host = surface.matches('[data-terminal-capsule-host]')
      ? surface
      : surface.querySelector('[data-terminal-capsule-host]');
    // Reachability, so "outside the host" cannot be satisfied by dropping the
    // attribute from the tree.
    expect(host).not.toBeNull();
    return host as HTMLElement;
  }

  it('keeps the delivery-unknown notice out of the host', () => {
    const view = renderSurface('web', { inputDrop: { reason: 'epoch', chunks: 1, at: 0 } });
    openNotices();
    const notice = view.getByTestId('terminal-input-drop');

    expect(hostOf(view).contains(notice)).toBe(false);
  });

  it('keeps the observer bar out of the host', () => {
    // The same geometry as the notice, and the same occlusion — it predates
    // #1307, which is why it is asserted here rather than in that change.
    const view = renderSurface('web', { terminalControl: { role: 'observer' } });
    openNotices();
    const bar = view.getByTestId('terminal-observer-bar');

    expect(hostOf(view).contains(bar)).toBe(false);
  });

  it('shows the degraded-history notice only while the runtime reports an observed gap (#2155)', () => {
    const healthy = renderSurface('web', { historyDegraded: false });
    expect(healthy.queryByTestId('terminal-history-degraded')).toBeNull();
    healthy.unmount();

    const degraded = renderSurface('web', { historyDegraded: true });
    openNotices();
    const notice = degraded.getByTestId('terminal-history-degraded');
    expect(notice).toHaveTextContent(/history may be incomplete/i);
    // The on-demand details are portaled outside the capsule host.
    expect(hostOf(degraded).contains(notice)).toBe(false);
  });

  it('wraps the well and the capsule the band exists for', () => {
    const view = renderSurface('web');
    const host = hostOf(view);

    expect(host.contains(view.getByTestId('terminal-viewport-slot'))).toBe(true);
    expect(host.contains(view.getByTestId('terminal-capsule'))).toBe(true);
  });
});

describe('explicit stream state (#1926 SC-08)', () => {
  it('publishes the runtime answer as a contract attribute', () => {
    for (const state of ['synchronized', 'degraded-live', 'unavailable'] as const) {
      const view = renderSurface('web', { streamState: state });
      expect(view.getByTestId('terminal-surface'))
        .toHaveAttribute('data-terminal-stream-state', state);
      view.unmount();
    }
  });

  it('defaults to unavailable when no runtime answer is supplied', () => {
    const view = renderSurface('web');
    expect(view.getByTestId('terminal-surface'))
      .toHaveAttribute('data-terminal-stream-state', 'unavailable');
  });
});

/**
 * The former top overlay (#2621) is entirely gone. Even while observing or
 * losing clipboard/input/history, no pixels may be laid over the terminal.
 */
describe('Terminal notices stay off the grid', () => {
  it('has no status placeholder in the healthy/controller state', () => {
    renderSurface('web');
    expect(screen.queryByTestId('terminal-status-overlay')).toBeNull();
    expect(screen.queryByTestId('terminal-notices-trigger')).toBeNull();
  });

  it('keeps all notice details inaccessible until explicitly opened in the capsule', () => {
    const view = renderSurface('web', {
      historyDegraded: true,
      inputDrop: { reason: 'epoch', chunks: 1, at: 0 },
      clipboardNotice: { id: 1, notice: { kind: 'write-denied' } },
      terminalControl: { role: 'observer' },
    });
    const root = view.getByTestId('terminal-surface');
    const host = root.querySelector('[data-terminal-capsule-host]');

    expect(root.children).toHaveLength(1);
    expect(host).toHaveClass('flex-1');
    expect(view.queryByTestId('terminal-status-overlay')).toBeNull();
    expect(view.queryByTestId('terminal-notice-details')).toBeNull();
    expect(view.getByTestId('terminal-notices-trigger')).toBeInTheDocument();

    openNotices();
    const details = view.getByTestId('terminal-notice-details');
    expect(host?.contains(details)).toBe(false);
    for (const testId of [
      'terminal-history-degraded',
      'terminal-input-drop',
      'terminal-clipboard-notice',
      'terminal-observer-bar',
    ]) {
      expect(details).toContainElement(view.getByTestId(testId));
    }
  });

  it('does not reopen a dismissed detail when a later notice appears', () => {
    const view = (id: number | null) => (
      <TerminalSurface
        experience="web"
        inputDisabled={false}
        controller={null}
        clipboardNotice={id === null ? null : { id, notice: { kind: 'write-denied' } }}
      >
        <div data-testid="terminal-viewport-slot" />
      </TerminalSurface>
    );
    const rendered = render(view(1));
    openNotices();
    expect(screen.getByTestId('terminal-notice-details')).toBeInTheDocument();
    rendered.rerender(view(null));
    expect(screen.queryByTestId('terminal-notice-details')).toBeNull();
    rendered.rerender(view(2));
    expect(screen.queryByTestId('terminal-notice-details')).toBeNull();
    expect(screen.getByTestId('terminal-notices-trigger')).toBeInTheDocument();
  });

  it('retains observer takeover as an explicit action', async () => {
    const onTakeControl = vi.fn();
    const view = renderSurface('app', {
      terminalControl: { role: 'observer' },
      onTakeControl,
    });

    expect(view.queryByTestId('terminal-observer-bar')).toBeNull();
    openNotices();
    const badge = view.getByTestId('terminal-observer-bar');
    expect(badge).toHaveTextContent('View only — another client is controlling this session.');
    await userEvent.click(view.getByRole('button', { name: 'Take control' }));
    expect(onTakeControl).toHaveBeenCalledTimes(1);
  });
});

describe('transient clipboard state (#2598)', () => {
  it('states an unsupported image paste without inventing a capability', () => {
    const view = renderSurface('web', {
      clipboardNotice: { id: 1, notice: { kind: 'unsupported-image-paste' } },
    });
    openNotices();
    const notice = view.getByTestId('terminal-clipboard-notice');
    expect(notice).toHaveTextContent('Image clipboard protocol not supported by this TUI');
    // A root-owned overlay outside the capsule host, not a reserved flex row.
    const host = view.getByTestId('terminal-surface')
      .querySelector('[data-terminal-capsule-host]');
    expect(host?.contains(notice)).toBe(false);
    expect(notice).not.toHaveAttribute('tabindex');
  });

  it('completes a blocked copy through an explicit user gesture on a secure origin', async () => {
    const copyClipboardText = vi.fn<(text: string) => Promise<boolean>>(async () => true);
    const onDismissClipboardNotice = vi.fn();
    const view = renderSurface('web', {
      controller: {
        canWriteClipboardProgrammatically: () => true,
        copyClipboardText,
        copyClipboardTextFromGesture: () => false,
      } as unknown as TerminalSurfaceProps['controller'],
      clipboardNotice: { id: 1, notice: { kind: 'copy-required', text: 'remote text' } },
      onDismissClipboardNotice,
    });
    openNotices();
    await userEvent.click(view.getByRole('button', { name: 'Copy' }));
    expect(copyClipboardText).toHaveBeenCalledWith('remote text');
    await Promise.resolve();
    expect(onDismissClipboardNotice).toHaveBeenCalled();
  });

  it('uses the synchronous DOM copy on an HTTP origin instead of the absent async API (#2614)', () => {
    // The capability is false exactly when the browser would expose no
    // navigator.clipboard (plain HTTP): the click must not start an async call
    // that can only fail after the user activation is spent.
    const copyClipboardText = vi.fn<(text: string) => Promise<boolean>>(async () => false);
    const copyClipboardTextFromGesture = vi.fn<(text: string) => boolean>(() => true);
    const onDismissClipboardNotice = vi.fn();
    const view = renderSurface('web', {
      controller: {
        canWriteClipboardProgrammatically: () => false,
        copyClipboardText,
        copyClipboardTextFromGesture,
      } as unknown as TerminalSurfaceProps['controller'],
      clipboardNotice: { id: 1, notice: { kind: 'copy-required', text: 'remote text' } },
      onDismissClipboardNotice,
    });
    openNotices();
    fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    // Synchronous within the gesture: no await happened before the DOM copy.
    expect(copyClipboardTextFromGesture).toHaveBeenCalledWith('remote text');
    expect(copyClipboardText).not.toHaveBeenCalled();
    expect(onDismissClipboardNotice).toHaveBeenCalled();
  });

  it('offers the exact text for manual copy when no gesture path can act (#2614)', async () => {
    const onDismissClipboardNotice = vi.fn();
    const view = renderSurface('web', {
      controller: {
        canWriteClipboardProgrammatically: () => false,
        copyClipboardText: async () => false,
        copyClipboardTextFromGesture: () => false,
      } as unknown as TerminalSurfaceProps['controller'],
      clipboardNotice: { id: 1, notice: { kind: 'copy-required', text: 'remote text' } },
      onDismissClipboardNotice,
    });
    openNotices();
    await userEvent.click(view.getByRole('button', { name: 'Copy' }));
    expect(view.getByTestId('terminal-clipboard-notice')).toHaveTextContent(
      'select the text below and press Ctrl/Cmd+C',
    );
    const manual = view.getByTestId('terminal-clipboard-manual');
    expect(manual).toHaveValue('remote text');
    // A read-only payload the user selects; it must not grab focus itself.
    expect(manual).toHaveAttribute('readonly');
    expect(document.activeElement).not.toBe(manual);
    expect(onDismissClipboardNotice).not.toHaveBeenCalled();
  });

  it('never presents a truncated payload as copyable (#2614)', async () => {
    const view = renderSurface('web', {
      controller: {
        canWriteClipboardProgrammatically: () => false,
        copyClipboardText: async () => false,
        copyClipboardTextFromGesture: () => false,
      } as unknown as TerminalSurfaceProps['controller'],
      clipboardNotice: { id: 1, notice: { kind: 'copy-required', text: 'x'.repeat(64 * 1024 + 1) } },
    });
    openNotices();
    await userEvent.click(view.getByRole('button', { name: 'Copy' }));
    expect(view.getByTestId('terminal-clipboard-notice'))
      .toHaveTextContent('too large to copy here');
    expect(view.queryByTestId('terminal-clipboard-manual')).toBeNull();
  });

  it('keeps a refused write truthful instead of claiming a copy', () => {
    const view = renderSurface('app', {
      clipboardNotice: { id: 1, notice: { kind: 'write-denied' } },
    });
    openNotices();
    expect(view.getByTestId('terminal-clipboard-notice'))
      .toHaveTextContent('Clipboard write was blocked by the browser.');
    expect(view.queryByRole('button', { name: 'Copy' })).toBeNull();
  });
});

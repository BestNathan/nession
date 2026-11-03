import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

/** The disclosure is the only place notice content may exist (#2658). */
async function openNotices(view: ReturnType<typeof renderSurface>) {
  await userEvent.click(view.getByTestId('terminal-notices-trigger'));
  return view.getByTestId('terminal-notice-details');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalSurface', () => {
  it('hosts xterm tree and floating capsule without legacy layout', () => {
    renderSurface('web');

    // The host is the *inner* box, not the surface root: it carries the
    // scrollback mode and the capsule the occlusion band is drawn for. Notice
    // content is opt-in (#2658), so nothing else is mounted beside it.
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
 * #2658: the owner decision that supersedes #2621's automatic overlay.
 *
 * The Terminal mounts no notice at rest and none while a state exists: the
 * Capsule gains one contextual action, and the same sentences/actions live in
 * a disclosure the user opens. The diagnostic token names what is available
 * without putting the content (or clipboard text) in the DOM.
 */
describe('Terminal notices stay off the grid (#2658)', () => {
  it('mounts no notice, trigger, or placeholder in the healthy state', () => {
    const view = renderSurface('web');

    expect(view.queryByTestId('terminal-notices-trigger')).toBeNull();
    expect(view.queryByTestId('terminal-notice-details')).toBeNull();
    expect(view.queryByTestId('terminal-status-overlay')).toBeNull();
    expect(view.getByTestId('terminal-surface')).not.toHaveAttribute('data-terminal-notices');
  });

  it('mounts an existing notice only after the user opens the disclosure', async () => {
    const view = renderSurface('web', { inputDrop: { reason: 'epoch', chunks: 1, at: 0 } });

    // The trigger is the only automatic trace, and it carries no sentence.
    expect(view.getByTestId('terminal-notices-trigger')).toBeInTheDocument();
    expect(view.queryByTestId('terminal-input-drop')).toBeNull();
    expect(view.getByTestId('terminal-surface'))
      .toHaveAttribute('data-terminal-notices', 'input-drop');

    await openNotices(view);
    expect(view.getByTestId('terminal-input-drop')).toHaveTextContent(
      'Some input may not have reached the session — check before re-running it.',
    );
    // The dialog portals out of the capsule host: it cannot cover the grid as
    // ambient chrome, and it is not part of the host's flex layout.
    const host = view.getByTestId('terminal-surface')
      .querySelector('[data-terminal-capsule-host]');
    expect(host?.contains(view.getByTestId('terminal-notice-details'))).toBe(false);
  });

  it('accounts for the losses the client can explain', async () => {
    const explained: Array<[Parameters<typeof renderSurface>[1], string]> = [
      [{ inputDrop: { reason: 'age', chunks: 2, at: 0 } }, 'it waited too long'],
      [{ inputDrop: { reason: 'bound', chunks: 1, at: 0 } }, 'too much was already waiting'],
      [{ inputDrop: { reason: 'generation', chunks: 1, at: 0 } }, 'another client took control'],
    ];

    for (const [props, phrase] of explained) {
      const view = renderSurface('web', props);
      const details = await openNotices(view);
      expect(details).toHaveTextContent(phrase);
      view.unmount();
    }
  });

  it('offers Dismiss exactly once for a lost input and closes after it', async () => {
    const onDismissInputDrop = vi.fn();
    const view = renderSurface('web', {
      inputDrop: { reason: 'epoch', chunks: 1, at: 0 },
      onDismissInputDrop,
    });

    await openNotices(view);
    const strip = view.getByTestId('terminal-input-drop');
    expect(strip.querySelectorAll('button')).toHaveLength(1);
    await userEvent.click(view.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissInputDrop).toHaveBeenCalledTimes(1);
  });

  it('shows the degraded-history sentence only on demand (#2155)', async () => {
    const healthy = renderSurface('web');
    expect(healthy.queryByTestId('terminal-notices-trigger')).toBeNull();
    healthy.unmount();

    const degraded = renderSurface('web', { historyDegraded: true });
    const details = await openNotices(degraded);
    expect(details).toHaveTextContent(/history may be incomplete/i);
  });

  it('keeps the observer takeover action reachable on demand', async () => {
    const onTakeControl = vi.fn();
    const view = renderSurface('app', {
      terminalControl: { role: 'observer' },
      onTakeControl,
    });

    expect(view.getByTestId('terminal-surface'))
      .toHaveAttribute('data-terminal-notices', 'observer');
    const details = await openNotices(view);
    expect(details).toHaveTextContent('View only — another client is controlling this session.');
    await userEvent.click(view.getByRole('button', { name: 'Take control' }));
    expect(onTakeControl).toHaveBeenCalledTimes(1);
  });

  it('does not reopen after the last notice expires', async () => {
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
    await openNotices(rendered);
    expect(screen.getByTestId('terminal-notice-details')).toBeInTheDocument();

    rendered.rerender(view(null));
    expect(screen.queryByTestId('terminal-notice-details')).toBeNull();
    expect(screen.queryByTestId('terminal-notices-trigger')).toBeNull();

    rendered.rerender(view(2));
    expect(screen.queryByTestId('terminal-notice-details')).toBeNull();
    expect(screen.getByTestId('terminal-notices-trigger')).toBeInTheDocument();
  });

  it('does not reopen a disclosure the user closed', async () => {
    const view = (id: number) => (
      <TerminalSurface
        experience="web"
        inputDisabled={false}
        controller={null}
        clipboardNotice={{ id, notice: { kind: 'write-denied' } }}
      >
        <div data-testid="terminal-viewport-slot" />
      </TerminalSurface>
    );
    const rendered = render(view(1));
    await openNotices(rendered);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('terminal-notice-details')).toBeNull();

    rendered.rerender(view(2));
    expect(screen.queryByTestId('terminal-notice-details')).toBeNull();
    expect(screen.getByTestId('terminal-notices-trigger')).toBeInTheDocument();
  });

  it('expires the clipboard state even while the disclosure stays closed', () => {
    vi.useFakeTimers();
    const onDismissClipboardNotice = vi.fn();
    renderSurface('web', {
      clipboardNotice: { id: 1, notice: { kind: 'write-denied' } },
      onDismissClipboardNotice,
    });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onDismissClipboardNotice).toHaveBeenCalledTimes(1);
  });

  it('does not restart expiry when a parent recreates the notice props', () => {
    vi.useFakeTimers();
    const onDismissClipboardNotice = vi.fn();
    // Fresh object and fresh callback identity on every parent render, as the
    // fixtures do: neither may buy the transient state another full window.
    const view = (notice: TerminalSurfaceProps['clipboardNotice']) => (
      <TerminalSurface
        experience="web"
        inputDisabled={false}
        controller={null}
        clipboardNotice={notice}
        onDismissClipboardNotice={() => onDismissClipboardNotice()}
      >
        <div data-testid="terminal-viewport-slot" />
      </TerminalSurface>
    );
    const rendered = render(view({ id: 1, notice: { kind: 'write-denied' } }));

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    rendered.rerender(view({ id: 1, notice: { kind: 'write-denied' } }));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onDismissClipboardNotice).toHaveBeenCalledTimes(1);
  });

  it('gives copy-required a fresh 30 s once the user opens the disclosure', () => {
    vi.useFakeTimers();
    const onDismissClipboardNotice = vi.fn();
    const view = renderSurface('web', {
      clipboardNotice: { id: 1, notice: { kind: 'copy-required', text: 'remote text' } },
      onDismissClipboardNotice,
    });

    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(onDismissClipboardNotice).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(view.getByTestId('terminal-notices-trigger'));
    });
    // The unopened 10 s window is replaced by 30 s from the opening gesture.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(onDismissClipboardNotice).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismissClipboardNotice).toHaveBeenCalledTimes(1);
  });
});

describe('transient clipboard state (#2598)', () => {
  it('keeps clipboard text out of the DOM until disclosure', async () => {
    const view = renderSurface('web', {
      clipboardNotice: { id: 1, notice: { kind: 'copy-required', text: 'remote text' } },
    });

    expect(document.body.textContent).not.toContain('remote text');
    await openNotices(view);
    expect(view.getByTestId('terminal-clipboard-notice'))
      .toHaveTextContent('The terminal wants to copy to your clipboard.');
    expect(document.body.textContent).not.toContain('remote text');
  });

  it('states an unsupported image paste without inventing a capability', async () => {
    const view = renderSurface('web', {
      clipboardNotice: { id: 1, notice: { kind: 'unsupported-image-paste' } },
    });
    const details = await openNotices(view);
    expect(view.getByTestId('terminal-clipboard-notice')).toHaveTextContent(
      'Image clipboard protocol not supported by this TUI',
    );
    expect(details).toHaveAttribute('data-testid', 'terminal-notice-details');
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
    await openNotices(view);
    await userEvent.click(view.getByRole('button', { name: 'Copy' }));
    expect(copyClipboardText).toHaveBeenCalledWith('remote text');
    await Promise.resolve();
    expect(onDismissClipboardNotice).toHaveBeenCalled();
  });

  it('uses the synchronous DOM copy on an HTTP origin instead of the absent async API (#2614)', async () => {
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
    await openNotices(view);
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
    await openNotices(view);
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
    await openNotices(view);
    await userEvent.click(view.getByRole('button', { name: 'Copy' }));
    expect(view.getByTestId('terminal-clipboard-notice'))
      .toHaveTextContent('too large to copy here');
    expect(view.queryByTestId('terminal-clipboard-manual')).toBeNull();
  });

  it('keeps a refused write truthful instead of claiming a copy', async () => {
    const view = renderSurface('app', {
      clipboardNotice: { id: 1, notice: { kind: 'write-denied' } },
    });
    await openNotices(view);
    expect(view.getByTestId('terminal-clipboard-notice'))
      .toHaveTextContent('Clipboard write was blocked by the browser.');
    expect(view.queryByRole('button', { name: 'Copy' })).toBeNull();
  });
});

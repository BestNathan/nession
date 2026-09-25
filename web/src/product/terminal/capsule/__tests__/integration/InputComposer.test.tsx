import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';

vi.mock('@/product/terminal/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [{ id: '1', command: 'ls -la', timestamp: Date.now() }],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([
      { id: '1', command: 'ls -la', timestamp: Date.now() },
    ]),
  }),
}));

/** A capability that earned disclosure, so the leading `+` renders. */
const disclosure = {
  entries: [{ id: 'claude-code', title: 'Claude Code', state: 'active' as const }],
  onSelect: vi.fn(),
};

function renderWebCapsule() {
  return render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
}

function renderAppCapsule() {
  return render(
    <TerminalCapsule experience="app" sendText={vi.fn()} capabilityDisclosure={disclosure} />,
  );
}

/**
 * #1034's two axes on one control: the box that takes the tap names
 * `control.md`, and the affordance drawn inside it names `control.visualSize`.
 *
 * Both bands are asserted on the *token each class names*, never on px: on App
 * `control.sm` and `control.md` are both 44px, so a control that regressed to
 * the smaller band measures identically, and a 44px circle inside a 44px target
 * is exactly the shape the split was introduced to end.
 */
function expectTwoBandControl(testId: string) {
  const control = screen.getByTestId(testId);
  expect(control.className).toMatch(/control-md/);
  expect(control.className).not.toMatch(/control-sm/);
  expect(within(control).getByTestId('capsule-control-visual').className).toMatch(
    /control-visual-size/,
  );
  return control;
}

describe('InputComposer', () => {
  it('shows History + Send on the right by default (no paste/copy/commands)', () => {
    renderWebCapsule();
    expect(screen.getByTestId('capsule-history-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-send')).toBeInTheDocument();
    expect(screen.queryByTestId('capsule-paste')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capsule-copy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capsule-commands-trigger')).not.toBeInTheDocument();
    expect(screen.getByTestId('capsule-input-actions-slot')).toBeInTheDocument();
  });

  it('leads with the capability entry, not the trailing actions', () => {
    render(
      <TerminalCapsule experience="web" sendText={vi.fn()} capabilityDisclosure={disclosure} />,
    );
    // The resting capsule carries `+` in the leading slot and nothing else there
    // (terminal-capsule.md §Anatomy: `[+] [ input ... ] [send]`).
    const leading = within(screen.getByTestId('capsule-input-leading-slot'));
    expect(leading.getByTestId('capsule-capability-more')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('capsule-input-actions-slot')).queryByTestId(
        'capsule-capability-more',
      ),
    ).not.toBeInTheDocument();
  });

  it('wires the history trigger on web and omits it on app', () => {
    const web = render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    expect(screen.getByTestId('capsule-history-trigger')).toHaveAttribute('aria-haspopup', 'dialog');
    web.unmount();

    renderAppCapsule();
    expect(screen.queryByTestId('capsule-history-trigger')).not.toBeInTheDocument();
  });

  it('asks for intent in the experience’s own words', () => {
    const web = render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    expect(screen.getByTestId('capsule-ghost-input')).toHaveAttribute('placeholder', 'Send input…');
    web.unmount();

    renderAppCapsule();
    expect(screen.getByTestId('capsule-ghost-input')).toHaveAttribute(
      'placeholder',
      'Ask Nession…',
    );
  });

  it('disables send when empty and sends trimmed input with carriage return', async () => {
    const sendText = vi.fn();
    render(<TerminalCapsule experience="web" sendText={sendText} />);
    expect(screen.getByTestId('capsule-send')).toBeDisabled();
    await userEvent.type(screen.getByTestId('capsule-ghost-input'), 'hello');
    await userEvent.click(screen.getByTestId('capsule-send'));
    expect(sendText).toHaveBeenCalledWith('hello\r');
  });

  it('uses flat inline row on web single-line input', () => {
    renderWebCapsule();
    const row = screen.getByTestId('capsule-input-row');
    expect(row).toHaveAttribute('data-layout', 'flat');
    expect(row.className).toMatch(/grid-cols-\[auto_minmax/);
    expect(screen.queryByTestId('capsule-input-toolbar-row')).not.toBeInTheDocument();
  });

  it('keeps the App resting capsule on the single row', () => {
    // The App capsule is the intent composer at rest, not a two-row sheet:
    // `+`, field, send, one band — which is why its row measures `control.md`
    // (44px) rather than a field row stacked on a toolbar row.
    renderAppCapsule();
    const row = screen.getByTestId('capsule-input-row');
    expect(row).toHaveAttribute('data-layout', 'flat');
    expect(row).not.toHaveAttribute('data-field-first');
    expect(screen.queryByTestId('capsule-input-toolbar-row')).not.toBeInTheDocument();
    expect(screen.getByTestId('capsule-input-field')).toHaveAttribute(
      'data-input-width',
      'column',
    );
    expect(
      within(screen.getByTestId('capsule-input-leading-slot')).getByTestId(
        'capsule-capability-more',
      ),
    ).toBeInTheDocument();
  });

  it('stays flat when empty even if scrollHeight looks multi-line', async () => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 52;
      },
    });

    try {
      renderWebCapsule();
      await waitFor(() => {
        expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
          'data-layout',
          'flat',
        );
      });
      expect(screen.getByTestId('terminal-capsule')).toHaveAttribute(
        'data-layout',
        'flat',
      );
    } finally {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
    }
  });

  it('uses token font-size classes on the field', () => {
    renderWebCapsule();
    const input = screen.getByTestId('capsule-ghost-input');
    expect(input.className).toMatch(/terminal-capsule-font-size/);
  });

  it('renders every capsule control at the control token, never a smaller band', () => {
    // Regression: the capsule's controls once rendered at `control-sm` while
    // `pattern.terminal-capsule` names `control.md` as the band for both
    // experiences. No px assertion could see it — on App both tokens are 44px —
    // so the invariant is asserted on the token the class names.
    //
    // Two bands since #1034, and both are asserted because either alone passes
    // for the wrong reason. The OUTER control is the hit target (`control.md`,
    // 44px on App) and the inner `capsule-control-visual` is the affordance
    // drawn inside it (`control.visualSize`, 36px on App). An outer that named
    // `control-sm` is the old regression; an inner that named `control-md` is
    // the silent revert of #1034 — every secondary action back to a 44px
    // filled square, at a size no measurement can distinguish from the target
    // around it.
    const app = renderAppCapsule();
    for (const testId of ['capsule-capability-more', 'capsule-send']) {
      expectTwoBandControl(testId);
    }
    app.unmount();

    // The history trigger is Web's (App declares no permanent history control);
    // it is the third caller of the split, so it gets the same assertion.
    renderWebCapsule();
    expectTwoBandControl('capsule-history-trigger');
  });

  it('keeps the painted affordance off the hit target, so the box never fills', async () => {
    // Point 4 of the split: the shadcn `Button` *variant* paints the outer
    // element (`default` → `bg-primary`, `ghost` → `hover:bg-muted`), so moving
    // the circle inside does not on its own stop the 44px box from filling. On
    // touch the hover sticks, and every secondary action becomes a filled 44px
    // square again — the exact regression #1034 exists to end. The paint belongs
    // to the inner visual; the control is transparent at rest and on hover.
    renderAppCapsule();
    for (const testId of ['capsule-capability-more', 'capsule-send']) {
      const control = screen.getByTestId(testId);
      expect(control.className).not.toMatch(/bg-foreground/);
      expect(control.className).toMatch(/hover:bg-transparent/);
      expect(control.className).not.toMatch(/hover:bg-(?!transparent)/);
    }

    // …and the fill the send control gave up is on its circle, not nowhere: the
    // primary action stays a filled affordance, just a 36px one. Typed input so
    // the fill under test is the enabled one (`bg-foreground`), not the
    // disabled `bg-muted`.
    await userEvent.type(screen.getByTestId('capsule-ghost-input'), 'ls');
    expect(
      within(screen.getByTestId('capsule-send')).getByTestId('capsule-control-visual').className,
    ).toMatch(/bg-foreground/);
  });

  it('drops tooltips on app, where they would intercept touch', () => {
    renderAppCapsule();
    expect(screen.getByTestId('capsule-send')).not.toHaveAttribute(
      'data-slot',
      'tooltip-trigger',
    );
  });

  it('keeps tooltips on web, where a pointer can hover', () => {
    renderWebCapsule();
    expect(screen.getByTestId('capsule-send')).toHaveAttribute(
      'data-slot',
      'tooltip-trigger',
    );
  });

  it('switches to stacked layout for multi-line without dropping focus', async () => {
    renderWebCapsule();
    const input = screen.getByTestId('capsule-ghost-input');
    input.focus();
    await userEvent.type(input, 'line1{Shift>}{Enter}{/Shift}line2');

    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'stacked',
      );
    });
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId('capsule-input-field')).toHaveAttribute(
      'data-input-width',
      'full',
    );
    expect(screen.getByTestId('capsule-input-toolbar-row')).toBeInTheDocument();
  });

  it('does not oscillate when soft-wrap height depends on layout width', async () => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        // Implementation name, deliberately not the product one: this testid
        // belongs to the `measure/` subsystem (readComposerMetrics), not to the
        // design system's token vocabulary. `terminal-capsule.md` §Implementation
        // migration treats InputComposer/measure as assets to converge, not as
        // the product boundary — so the token rename does not reach here.
        if (this.dataset.testid === 'capsule-composer-measure-mirror') {
          return this.value.length >= 24 ? 64 : 32;
        }
        return 32;
      },
    });

    try {
      renderWebCapsule();
      const input = screen.getByTestId('capsule-ghost-input');
      await userEvent.type(input, 'x'.repeat(28));

      await waitFor(() => {
        expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
          'data-layout',
          'stacked',
        );
      });
      expect(screen.getByTestId('terminal-capsule')).toHaveAttribute(
        'data-layout',
        'stacked',
      );
    } finally {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
    }
  });

  it('returns to flat when content is single line again', async () => {
    renderWebCapsule();
    const input = screen.getByTestId('capsule-ghost-input');
    await userEvent.type(input, 'a{Shift>}{Enter}{/Shift}b');
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'stacked',
      );
    });
    await userEvent.clear(input);
    await userEvent.type(input, 'one');
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'flat',
      );
    });
    expect(document.activeElement).toBe(input);
  });

  it('returns to flat after send clears input', async () => {
    const sendText = vi.fn();
    render(<TerminalCapsule experience="web" sendText={sendText} />);
    const input = screen.getByTestId('capsule-ghost-input');
    await userEvent.type(input, 'a{Shift>}{Enter}{/Shift}b');
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'stacked',
      );
    });
    await userEvent.click(screen.getByTestId('capsule-send'));
    expect(sendText).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('capsule-input-row')).toHaveAttribute(
        'data-layout',
        'flat',
      );
    });
  });
});

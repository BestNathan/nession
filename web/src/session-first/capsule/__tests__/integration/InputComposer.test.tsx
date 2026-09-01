import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalCapsule } from '@/session-first/capsule/TerminalCapsule';

vi.mock('@/hooks/useQuickCommands', () => ({
  useQuickCommands: () => ({
    userCommands: [],
    addCommand: vi.fn().mockResolvedValue(undefined),
    deleteCommand: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useCommandHistory', () => ({
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

function renderWebCapsule(onLayoutChange?: never) {
  void onLayoutChange;
  return render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
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

  it('shows paste/copy on app experience', () => {
    render(
      <TerminalCapsule
        experience="app"
        mode="input"
        onModeChange={vi.fn()}
        sendText={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-paste')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-copy')).toBeInTheDocument();
  });

  it('wires the history trigger in the composer toolbar', () => {
    render(<TerminalCapsule experience="web" sendText={vi.fn()} />);
    expect(screen.getByTestId('capsule-history-trigger')).toHaveAttribute('aria-haspopup', 'dialog');
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
    expect(row.className).toMatch(/grid-cols-\[minmax/);
    expect(screen.queryByTestId('capsule-input-toolbar-row')).not.toBeInTheDocument();
  });

  it('uses full-width field on app even when flat', () => {
    render(
      <TerminalCapsule
        experience="app"
        mode="input"
        onModeChange={vi.fn()}
        sendText={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-input-row')).toHaveAttribute('data-field-first', 'app');
    expect(screen.getByTestId('capsule-input-field')).toHaveAttribute('data-input-width', 'full');
    expect(screen.getByTestId('capsule-input-toolbar-row')).toBeInTheDocument();
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
    expect(input.className).toMatch(/composer-font-size/);
  });

  it('uses compact secondary controls on app', () => {
    render(
      <TerminalCapsule
        experience="app"
        mode="input"
        onModeChange={vi.fn()}
        sendText={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capsule-history-trigger').className).toMatch(/control-sm/);
    expect(screen.getByTestId('capsule-send').className).toMatch(/control-md/);
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

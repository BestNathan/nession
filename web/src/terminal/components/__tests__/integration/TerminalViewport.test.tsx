import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalViewport } from '@/terminal/components/TerminalViewport';
import type { TerminalController } from '@/terminal/controller/TerminalController';

function makeController(): TerminalController {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as TerminalController;
}

describe('TerminalViewport', () => {
  it('renders a div with the terminal background colour', () => {
    const controller = makeController();
    const { container } = render(<TerminalViewport controller={controller} />);

    const el = container.firstElementChild;
    expect(el).not.toBeNull();
    expect(el).toHaveClass('h-full', 'w-full', 'bg-terminal-background');
  });

  it('reserves the capsule occlusion inside the xterm viewport', () => {
    const controller = makeController();
    const { container } = render(<TerminalViewport controller={controller} />);

    expect(container.firstElementChild).toHaveStyle({
      paddingBottom: 'var(--terminal-content-bottom-inset, 0px)',
    });
  });

  it('calls controller.attach on mount and detach on unmount', () => {
    const controller = makeController();
    const { unmount } = render(<TerminalViewport controller={controller} />);

    expect(controller.attach).toHaveBeenCalledTimes(1);

    unmount();
    expect(controller.detach).toHaveBeenCalledTimes(1);
  });
});

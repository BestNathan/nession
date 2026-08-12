import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TerminalViewport } from '../TerminalViewport';
import type { TerminalController } from '../../controller/TerminalController';

function makeController(): TerminalController {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as TerminalController;
}

describe('TerminalViewport', () => {
  it('renders a div with the terminal background colour', () => {
    const controller = makeController();
    const { container } = render(<TerminalViewport controller={controller} />);

    const el = container.firstElementChild;
    expect(el).not.toBeNull();
    expect(el).toHaveClass('h-full', 'w-full');
    expect(el).toHaveStyle({ backgroundColor: '#1e1e2e' });
  });

  it('calls controller.attach on mount and detach on unmount', () => {
    const controller = makeController();
    const { unmount } = render(<TerminalViewport controller={controller} />);

    expect(controller.attach).toHaveBeenCalledTimes(1);

    unmount();
    expect(controller.detach).toHaveBeenCalledTimes(1);
  });
});

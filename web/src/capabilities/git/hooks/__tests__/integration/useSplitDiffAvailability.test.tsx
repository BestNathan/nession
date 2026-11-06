import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SPLIT_DIFF_MIN_WIDTH,
  useSplitDiffAvailability,
} from '../../useSplitDiffAvailability';

function Probe({ width }: { width: number }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const available = useSplitDiffAvailability(element);
  return (
    <div
      ref={setElement}
      data-testid="probe"
      data-width={width}
      data-available={String(available)}
    />
  );
}

const originalClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'clientWidth',
);

afterEach(() => {
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  }
});

describe('useSplitDiffAvailability', () => {
  it('offers split only when the pane itself is wide enough', () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.width ? Number(this.dataset.width) : 0;
      },
    });

    const wide = render(<Probe width={SPLIT_DIFF_MIN_WIDTH} />);
    expect(screen.getByTestId('probe')).toHaveAttribute('data-available', 'true');
    wide.unmount();

    render(<Probe width={SPLIT_DIFF_MIN_WIDTH - 1} />);
    expect(screen.getByTestId('probe')).toHaveAttribute('data-available', 'false');
  });
});

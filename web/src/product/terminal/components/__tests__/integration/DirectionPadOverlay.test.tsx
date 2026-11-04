import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DirectionPadOverlay, type DirectionPadOverlayView } from '../../DirectionPadOverlay';

const view: DirectionPadOverlayView = {
  phase: 'moving',
  direction: 'up',
  gear: 2,
  rate: 4,
  count: 7,
  anchorX: 150,
  anchorY: 200,
  originX: 140,
  originY: 190,
  showOrigin: true,
};

describe('DirectionPadOverlay', () => {
  it('renders nothing when the pad is not armed', () => {
    const { container } = render(<DirectionPadOverlay view={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('states the active direction, rate and speed band', () => {
    render(<DirectionPadOverlay view={view} />);

    const dial = screen.getByTestId('terminal-direction-pad');
    expect(dial).toHaveAttribute('data-phase', 'moving');
    expect(dial).toHaveAttribute('data-direction', 'up');
    expect(dial).toHaveStyle({ left: '150px', top: '200px' });

    expect(screen.getByTestId('terminal-direction-pad-rate')).toHaveTextContent('4/s');
    expect(screen.getByTestId('terminal-direction-pad-count')).toHaveTextContent('7');

    const pips = screen.getAllByTestId('terminal-direction-pad-speed-pip');
    expect(pips).toHaveLength(4);
    expect(pips.map((pip) => pip.getAttribute('data-on'))).toEqual([
      'true',
      'true',
      'true',
      'false',
    ]);
  });

  it('highlights only the chosen arrow and marks the true finger origin when displaced', () => {
    render(<DirectionPadOverlay view={view} />);

    const arrows = screen.getAllByTestId('terminal-direction-pad-arrow');
    expect(arrows.map((arrow) => arrow.getAttribute('data-direction'))).toEqual([
      'up',
      'right',
      'down',
      'left',
    ]);
    expect(arrows.map((arrow) => arrow.getAttribute('data-active'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);

    expect(screen.getByTestId('terminal-direction-pad-origin')).toHaveStyle({
      left: '140px',
      top: '190px',
    });
  });

  it('hides the origin dot when the dial already sits on the finger', () => {
    render(<DirectionPadOverlay view={{ ...view, showOrigin: false }} />);
    expect(screen.queryByTestId('terminal-direction-pad-origin')).toBeNull();
  });

  it('shows an armed dial without an active direction', () => {
    render(
      <DirectionPadOverlay
        view={{ ...view, phase: 'armed', direction: null, gear: -1, rate: 0, count: 0 }}
      />,
    );
    const dial = screen.getByTestId('terminal-direction-pad');
    expect(dial).toHaveAttribute('data-direction', 'none');
    expect(screen.getByTestId('terminal-direction-pad-rate')).toHaveTextContent('·');
    expect(
      screen.getAllByTestId('terminal-direction-pad-speed-pip')
        .map((pip) => pip.getAttribute('data-on')),
    ).toEqual(['false', 'false', 'false', 'false']);
  });
});

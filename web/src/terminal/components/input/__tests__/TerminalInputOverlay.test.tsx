import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { TerminalInputOverlay } from '../TerminalInputOverlay';
import { inputModeAtomFamily } from '../../../state/input';

describe('TerminalInputOverlay', () => {
  it('renders null in terminal mode', () => {
    const store = createStore();
    const { container } = render(
      <Provider store={store}>
        <TerminalInputOverlay sessionId="s1" />
      </Provider>,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders null in command mode', () => {
    const store = createStore();
    store.set(inputModeAtomFamily('s1'), { type: 'command' });
    const { container } = render(
      <Provider store={store}>
        <TerminalInputOverlay sessionId="s1" />
      </Provider>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

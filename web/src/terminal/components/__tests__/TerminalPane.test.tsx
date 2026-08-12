import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { TerminalPane } from '../TerminalPane';

describe('TerminalPane', () => {
  it('renders without crashing', () => {
    const store = createStore();
    const { container } = render(
      <Provider store={store}>
        <TerminalPane sessionId="s1" controller={null} reconnectAttempt={0} />
      </Provider>,
    );

    expect(container).not.toBeNull();
  });
});

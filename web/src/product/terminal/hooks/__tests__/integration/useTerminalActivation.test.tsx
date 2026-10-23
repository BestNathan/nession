import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTerminalActivation } from '@/product/terminal/hooks/useTerminalActivation';

function setup(initial: {
  foreground?: boolean;
  attached?: boolean;
  sessionName?: string;
  adopt?: () => Promise<boolean>;
}) {
  const adoptControl = vi.fn(initial.adopt ?? (async () => true));
  const onAdopted = vi.fn();
  const hook = renderHook(
    (props: { foreground: boolean; attached: boolean; sessionName: string }) =>
      useTerminalActivation({
        sessionName: props.sessionName,
        foreground: props.foreground,
        attached: props.attached,
        adoptControl,
        onAdopted,
      }),
    {
      initialProps: {
        foreground: initial.foreground ?? true,
        attached: initial.attached ?? false,
        sessionName: initial.sessionName ?? 'sess',
      },
    },
  );
  return { ...hook, adoptControl, onAdopted };
}

/** Set `document.visibilityState` for one test (jsdom exposes it as readonly). */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  setVisibility('visible');
});

describe('useTerminalActivation', () => {
  it('takes the lease on the first foreground attach and states the viewport (#2286 SC-02)', async () => {
    const { rerender, adoptControl, onAdopted } = setup({ attached: false });

    rerender({ foreground: true, attached: true, sessionName: 'sess' });

    await waitFor(() => expect(onAdopted).toHaveBeenCalledTimes(1));
    expect(adoptControl).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the session is not attached', async () => {
    const { adoptControl, onAdopted } = setup({ attached: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(adoptControl).not.toHaveBeenCalled();
    expect(onAdopted).not.toHaveBeenCalled();
  });

  it('does not treat a reconnect re-attach as a new activation (#2286 SC-03)', async () => {
    const { rerender, adoptControl } = setup({ attached: false });

    rerender({ foreground: true, attached: true, sessionName: 'sess' });
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(1));

    // A transport reconnect drops and re-establishes the attach. That alone is
    // not the user choosing this terminal.
    rerender({ foreground: true, attached: false, sessionName: 'sess' });
    rerender({ foreground: true, attached: true, sessionName: 'sess' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(adoptControl).toHaveBeenCalledTimes(1);
  });

  it('takes the lease when the terminal surface returns to the foreground', async () => {
    const { rerender, adoptControl, onAdopted } = setup({ attached: false });
    rerender({ foreground: true, attached: true, sessionName: 'sess' });
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(1));

    rerender({ foreground: false, attached: true, sessionName: 'sess' });
    rerender({ foreground: true, attached: true, sessionName: 'sess' });

    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(2));
    expect(onAdopted).toHaveBeenCalledTimes(2);
  });

  it('does not activate a hidden terminal surface', async () => {
    const { rerender, adoptControl } = setup({ attached: false });
    rerender({ foreground: true, attached: true, sessionName: 'sess' });
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(1));

    rerender({ foreground: false, attached: true, sessionName: 'sess' });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(adoptControl).toHaveBeenCalledTimes(1);
  });

  it('takes the lease when the window regains focus on a visible terminal', async () => {
    const { rerender, adoptControl } = setup({ attached: false });
    rerender({ foreground: true, attached: true, sessionName: 'sess' });
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(2));
  });

  it('takes the lease when the document becomes visible again', async () => {
    const { rerender, adoptControl } = setup({ attached: false });
    rerender({ foreground: true, attached: true, sessionName: 'sess' });
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(adoptControl).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(2));
  });

  it('keeps a gesture made while attaching and acts once the attach lands', async () => {
    const { result, rerender, adoptControl, onAdopted } = setup({ attached: false });

    act(() => {
      result.current.onTerminalGesture();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(adoptControl).not.toHaveBeenCalled();

    rerender({ foreground: true, attached: true, sessionName: 'sess' });
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(1));
    expect(onAdopted).toHaveBeenCalledTimes(1);
  });

  it('does not keep a gesture made on a hidden surface', async () => {
    const { result, rerender, adoptControl } = setup({
      attached: false,
      foreground: false,
    });

    act(() => {
      result.current.onTerminalGesture();
    });
    rerender({ foreground: true, attached: true, sessionName: 'sess' });

    // The surface becoming foreground is its own activation; the ignored
    // gesture must not add a second one.
    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(1));
  });

  it('does not restate the viewport when the Agent says ownership did not move', async () => {
    const { rerender, adoptControl, onAdopted } = setup({
      attached: false,
      adopt: async () => false,
    });
    rerender({ foreground: true, attached: true, sessionName: 'sess' });

    await waitFor(() => expect(adoptControl).toHaveBeenCalledTimes(1));
    expect(onAdopted).not.toHaveBeenCalled();
  });
});

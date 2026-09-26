import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import { AttachDialog } from '@/product/session/components/AttachDialog';
import { envApi } from '@/capabilities/env';
import { sessionsApi } from '@/product/session';
import type { Session, AttachInfo, AddressLatency } from '@/types';
import { attachInfoAtom } from '@/product/session/state';
import { saveSessionProfile, type PersistedAttachChoice } from '@/platform/attach/sessionAttachProfile';

// Partial mock — see CreateSessionDialog.test.tsx: the barrel exports the
// capability's components too, and this dialog renders one of them.
vi.mock('@/capabilities/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/capabilities/env')>()),
  envApi: { listEnvFiles: vi.fn() },
}));

/**
 * Only `testAddresses` is mocked — the ordering a caller reads is the real one,
 * so these tests exercise the dialog's own probe rather than a seeded result.
 * The dialog used to read a cache filled by an app-level poll; it now measures
 * the candidates it was handed, with the attach reply's credential (#1091).
 */
const { testAddressesMock } = vi.hoisted(() => ({ testAddressesMock: vi.fn() }));

vi.mock('@/shared/lib/addressSelection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/lib/addressSelection')>()),
  testAddresses: testAddressesMock,
}));

/** Every candidate answers with the given latency, in the order given. */
function measures(...latencies: (number | null)[]): void {
  testAddressesMock.mockImplementation(async (addresses: { url: string }[]) =>
    addresses.map(
      (a, i): AddressLatency => ({ url: a.url, latencyMs: latencies[i] ?? null }),
    ),
  );
}

vi.mock('@/product/session', () => ({
  sessionsApi: { requestAttach: vi.fn() },
}));

const mockedEnvApi = vi.mocked(envApi);
const mockedSessionsApi = vi.mocked(sessionsApi);

function session(): Session {
  return {
    session_id: 'agent-1:dev',
    agent_id: 'agent-1',
    session_name: 'dev',
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: new Date().toISOString(),
  };
}

function attachInfo(addresses: AttachInfo['addresses'] = []): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent-1:dev',
    session_name: 'dev',
    agent_address: 'ws://a/ws',
    connection_token: 'tok',
    addresses,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedEnvApi.listEnvFiles.mockResolvedValue({ files: [] });
  mockedSessionsApi.requestAttach.mockImplementation(async () => attachInfo());
  measures();
});

describe('AttachDialog', () => {
  it('requests attach and confirms with a resolved choice (Auto)', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    // Attach button enables once attach info resolves.
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(mockedSessionsApi.requestAttach).toHaveBeenCalledWith('agent-1:dev', 'p2p', undefined);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'agent-1:dev' }),
      expect.objectContaining({ mode: 'auto', selectedUrl: null }),
    );
  });

  it('offers Auto, P2P, and Relay modes', () => {
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('P2P')).toBeInTheDocument();
    expect(screen.getByText('Relay')).toBeInTheDocument();
  });

  it('shows candidate paths and lets the user pick one', async () => {
    const onConfirm = vi.fn();
    mockedSessionsApi.requestAttach.mockImplementation(async () =>
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    measures(10, 20);
    const user = userEvent.setup();
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    // Both candidate labels appear once attach info resolves.
    expect(await screen.findByText('LAN')).toBeInTheDocument();
    expect(screen.getByText('VPN')).toBeInTheDocument();
    // …and the dialog measured them itself, with the reply's credential.
    await waitFor(() =>
      expect(testAddressesMock).toHaveBeenCalledWith(
        expect.anything(),
        { credential: 'tok' },
      ),
    );
    // Pick the VPN path explicitly (server marked it unreachable — user override
    // still allowed).
    await user.click(screen.getByText('VPN'));
    const attachBtn = screen.getByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        selectedUrl: 'ws://vpn/ws',
        // Latencies come from the app-level probe cache, handed to the terminal.
        latencies: expect.arrayContaining([
          expect.objectContaining({ url: 'ws://lan/ws', latencyMs: 10 }),
          expect.objectContaining({ url: 'ws://vpn/ws', latencyMs: 20 }),
        ]),
      }),
    );
  });

  it('shows the latency it measured for each candidate', async () => {
    mockedSessionsApi.requestAttach.mockImplementation(async () =>
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
        { url: 'ws://vpn/ws', label: 'VPN', network_type: 'vpn', priority: 20, status: 'unreachable' },
      ]),
    );
    measures(12, 40);
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={vi.fn()} />,
    );

    expect(await screen.findByText('12ms')).toBeInTheDocument();
    expect(screen.getByText('40ms')).toBeInTheDocument();
    // The Auto row names the fastest *reachable* one and how long it took.
    expect(screen.getByRole('button', { name: /fastest reachable path · 12ms/ })).toBeInTheDocument();
  });

  /**
   * The state that used to be mislabelled: `orderByLatency` appends failed
   * addresses rather than dropping them, so a total failure leaves
   * `orderedUrls[0]` a *failed* URL. Reading that as "the best path" is how the
   * Auto row came to promise a fastest reachable path that did not exist.
   */
  it('does not promise a fastest path when nothing answered', async () => {
    mockedSessionsApi.requestAttach.mockImplementation(async () =>
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
      ]),
    );
    measures(null);
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={vi.fn()} />,
    );

    expect(await screen.findByText(/nothing answered from this browser/)).toBeInTheDocument();
    expect(screen.queryByText(/fastest reachable path/)).not.toBeInTheDocument();
  });

  /**
   * The same defect in the branch that does not involve this browser at all:
   * relay rows render from the *server's* probe status, and `unknown` — the
   * server saying it has not looked — was drawn with the offline icon and a
   * destructive label, i.e. "this failed".
   */
  it('shows an unprobed relay address as unmeasured, not as a failure', async () => {
    mockedSessionsApi.requestAttach.mockImplementation(async () => ({
      mode: 'relay' as const,
      session_id: 'agent-1:dev',
      session_name: 'dev',
      addresses: [
        { url: 'ws://relay/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'unknown' as const },
      ],
    }));
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={vi.fn()} />,
    );

    await user.click(screen.getByRole('button', { name: /^Relay/ }));

    expect(await screen.findByText('not measured')).toBeInTheDocument();
    const label = screen.getByText('unknown');
    expect(label).toBeInTheDocument();
    expect(label).not.toHaveClass('text-destructive');
  });

  it('re-test re-requests attach info and measures again', async () => {
    mockedSessionsApi.requestAttach.mockImplementation(async () =>
      attachInfo([
        { url: 'ws://lan/ws', label: 'LAN', network_type: 'lan', priority: 10, status: 'reachable' },
      ]),
    );
    measures(30);
    const user = userEvent.setup();
    render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={vi.fn()} />,
    );

    await screen.findByText('30ms');
    expect(testAddressesMock).toHaveBeenCalledTimes(1);

    // A fresh reply carries a fresh credential, which is what re-measures — so
    // Re-test must re-request rather than re-probe a token that expires at
    // p2p_token_expiry_secs.
    measures(7);
    await user.click(await screen.findByRole('button', { name: /Re-test/ }));

    await waitFor(() => expect(mockedSessionsApi.requestAttach).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('7ms')).toBeInTheDocument();
  });

  it('renders a Renderer row with WebGL and Canvas options', () => {
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Renderer')).toBeInTheDocument();
    expect(screen.getByText('WebGL')).toBeInTheDocument();
    expect(screen.getByText('Canvas')).toBeInTheDocument();
  });

  it('selects env files and passes them as envRefs on confirm', async () => {
    const onConfirm = vi.fn();
    mockedEnvApi.listEnvFiles.mockResolvedValue({
      files: [{ name: 'prod.env', source: 'server', size: 10, modified: 0, var_count: 3 }],
    });
    const user = userEvent.setup();
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    // The env section starts collapsed; expand it to reveal the file list.
    await user.click(screen.getByText('Environment Files'));
    await user.click(await screen.findByText('prod.env'));
    const attachBtn = screen.getByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ envRefs: [{ name: 'prod.env', source: 'server' }] }),
    );
  });

  it('does not clear the active session attachInfoAtom when opened for preview', async () => {
    const store = createStore();
    // The currently-attached session's descriptor — a DIFFERENT session than
    // the one being previewed in the dialog. Opening the preview dialog must
    // not clobber this shared atom (it drives the live terminal).
    const activeInfo: AttachInfo = {
      mode: 'p2p',
      session_id: 'agent-2:prod',
      session_name: 'prod',
      agent_address: 'ws://other/ws',
      connection_token: 'active-token',
      addresses: [],
    };
    store.set(attachInfoAtom, activeInfo);

    render(
      <Provider store={store}>
        <AttachDialog
          isOpen
          onClose={vi.fn()}
          session={session()}
          onConfirm={vi.fn()}
        />
      </Provider>,
    );

    // Let the dialog's own attach-info fetch fully settle.
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());

    // The live session's descriptor must be untouched.
    expect(store.get(attachInfoAtom)).toEqual(activeInfo);
  });
});

describe('AttachDialog profile prefill + configure intent', () => {
  const choice: PersistedAttachChoice = {
    mode: 'p2p',
    renderer: 'webgl',
    envRefs: [],
    selectedUrl: null,
  };

  function seedProfile(overrides: Partial<PersistedAttachChoice> = {}) {
    saveSessionProfile(
      { session_id: 'agent-1:dev', agent_id: 'agent-1' },
      { ...choice, ...overrides },
      'any-fp',
    );
  }

  function seedRequest(addresses: AttachInfo['addresses'] = []) {
    mockedSessionsApi.requestAttach.mockResolvedValue(attachInfo(addresses));
  }

  it('prefills mode and renderer from the session profile', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    seedProfile({ mode: 'relay', renderer: 'canvas' });
    render(<AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirm} />);
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    // Relay mode selected → requestAttach asks for relay info.
    expect(mockedSessionsApi.requestAttach).toHaveBeenCalledWith('agent-1:dev', 'relay', undefined);
    await user.click(attachBtn);
    // The seeded profile values flow through to the confirm choice.
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'relay', renderer: 'canvas' }),
    );
  });

  it('prefills the manual url when it is still a candidate', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    seedProfile({ mode: 'p2p', selectedUrl: 'ws://a/ws' });
    seedRequest([
      { url: 'ws://a/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
    ]);
    render(<AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirm} />);
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'agent-1:dev' }),
      expect.objectContaining({ mode: 'p2p', selectedUrl: 'ws://a/ws' }),
    );
  });

  it('falls back to auto url when the saved manual url is gone', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    seedProfile({ mode: 'p2p', selectedUrl: 'ws://gone/ws' });
    seedRequest([
      { url: 'ws://a/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
    ]);
    render(<AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirm} />);
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ selectedUrl: null }),
    );
  });

  it('keeps an explicit Auto row pick across the relay refetch', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    // Relay profile whose saved manual path is still offered by the agent.
    seedProfile({ mode: 'relay', selectedUrl: 'ws://relay/ws' });
    seedRequest([
      { url: 'ws://relay/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
    ]);
    render(<AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirm} />);
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    // The saved manual url is preselected, which flips relayUrl and refires
    // the attach-info fetch for that endpoint — wait for that cycle to land.
    await waitFor(() =>
      expect(mockedSessionsApi.requestAttach).toHaveBeenLastCalledWith(
        'agent-1:dev',
        'relay',
        'ws://relay/ws',
      ),
    );
    // Explicitly pick the Auto path row (relay sublabel disambiguates it from
    // the Auto MODE toggle). relayUrl drops back to undefined and a refetch
    // fires; the re-landing info must NOT re-preselect the saved manual url.
    await user.click(screen.getByRole('button', { name: /^Auto server auto-selects/ }));
    await waitFor(() =>
      expect(mockedSessionsApi.requestAttach).toHaveBeenLastCalledWith(
        'agent-1:dev',
        'relay',
        undefined,
      ),
    );
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'relay', selectedUrl: null }),
    );
  });

  it('keeps profiles separate when reopening for another session', async () => {
    const onConfirmA = vi.fn();
    const onConfirmB = vi.fn();
    const user = userEvent.setup();
    // Session A: p2p with a manual url; session B: relay, server-auto only.
    saveSessionProfile(
      { session_id: 'agent-1:dev', agent_id: 'agent-1' },
      { mode: 'p2p', renderer: 'webgl', envRefs: [], selectedUrl: 'ws://a/ws' },
      'any-fp',
    );
    saveSessionProfile(
      { session_id: 'agent-1:other', agent_id: 'agent-1' },
      { mode: 'relay', renderer: 'canvas', envRefs: [], selectedUrl: null },
      'any-fp',
    );
    seedRequest([
      { url: 'ws://a/ws', label: 'lan', network_type: 'lan', priority: 0, status: 'reachable' },
    ]);
    const first = render(
      <AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirmA} />,
    );
    const attachBtnA = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtnA).toBeEnabled());
    await user.click(attachBtnA);
    expect(onConfirmA).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'p2p', selectedUrl: 'ws://a/ws' }),
    );
    first.unmount();
    render(
      <AttachDialog
        isOpen
        onClose={vi.fn()}
        session={{ ...session(), session_id: 'agent-1:other', session_name: 'other' }}
        onConfirm={onConfirmB}
      />,
    );
    const attachBtnB = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtnB).toBeEnabled());
    await user.click(attachBtnB);
    // B's own profile applies — nothing of A's manual url leaks in.
    expect(onConfirmB).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'relay', selectedUrl: null }),
    );
  });

  it('shows Save and still calls onConfirm once in configure mode', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachDialog
        isOpen
        intent="configure"
        onClose={vi.fn()}
        session={session()}
        onConfirm={onConfirm}
      />,
    );
    const saveBtn = await screen.findByRole('button', { name: /^Save$/ });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await user.click(saveBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows Attach (not Save) in attach mode', async () => {
    render(<AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={vi.fn()} />);
    await screen.findByRole('button', { name: /^Attach$/ });
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
  });

  it('prefills env file selection from the profile, filtering missing files', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    mockedEnvApi.listEnvFiles.mockResolvedValue({
      files: [{ name: 'prod.env', source: 'server', size: 10, modified: 0, var_count: 3 }],
    });
    seedProfile({
      envRefs: [
        { name: 'prod.env', source: 'server' },
        { name: 'gone.env', source: 'server' },
      ],
    });
    seedRequest();
    render(<AttachDialog isOpen onClose={vi.fn()} session={session()} onConfirm={onConfirm} />);
    const attachBtn = await screen.findByRole('button', { name: /^Attach$/ });
    await waitFor(() => expect(attachBtn).toBeEnabled());
    await user.click(attachBtn);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ envRefs: [{ name: 'prod.env', source: 'server' }] }),
    );
  });
});

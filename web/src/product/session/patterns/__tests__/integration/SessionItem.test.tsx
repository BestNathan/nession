import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionItem } from '@/product/session/patterns/SessionItem';
import type { DomainState } from '@/product/session/model/domainState';
import type { Session } from '@/types';

const session: Session = {
  session_id: 'a1:fix',
  agent_id: 'a1',
  session_name: 'Fix terminal reconnect',
  status: 'active',
  window_count: 1,
  attached_clients: 0,
  last_activity: new Date().toISOString(),
};

const domain: DomainState = {
  agent: { channel: 'online', copy: null },
  session: { channel: 'active', copy: null },
  attachment: { channel: 'detached', copy: null },
};

describe('SessionItem', () => {
  it('selects the session when the row is clicked', async () => {
    const onSelect = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId('session-item-a1:fix'));
    expect(onSelect).toHaveBeenCalledWith(session);
  });

  // jsdom does not apply group-hover; hover here exercises the row wrapper, click asserts behavior.
  it('calls onKill without selecting when kill is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onKill = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
        onKill={onKill}
      />,
    );
    const row = screen.getByTestId('session-item-row');
    await user.hover(row);
    const kill = screen.getByTestId('session-kill-a1:fix');
    await user.click(kill);
    expect(onKill).toHaveBeenCalledWith(session);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows kill when selected even without hover', () => {
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected
        onSelect={vi.fn()}
        onKill={vi.fn()}
      />,
    );
    const kill = screen.getByTestId('session-kill-a1:fix');
    expect(kill).toBeInTheDocument();
    expect(kill.className).toMatch(/opacity-100/);
    expect(kill.className).toMatch(/pointer-events-auto/);
  });

  it('keeps kill in DOM when not selected or hovered', () => {
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={vi.fn()}
        onKill={vi.fn()}
      />,
    );
    const kill = screen.getByTestId('session-kill-a1:fix');
    expect(kill).toBeInTheDocument();
    // Hidden state is lg+-only now: icons stay visible below the breakpoint.
    expect(kill.className).toMatch(/lg:opacity-0/);
    expect(kill.className).toMatch(/lg:pointer-events-none/);
    expect(kill.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(kill.className).not.toMatch(/(^|\s)pointer-events-none(\s|$)/);
  });

  /**
   * #1050 stage 4 — one line, three slots, two families.
   *
   * jsdom applies no stylesheet, so what is assertable here is the class
   * composition that decides the family. What it resolves to in a browser is
   * measured on the fixture (`just design-check browser` renders the App row at
   * 390×844), because a computed font is not something this environment has.
   */
  describe('typography roles', () => {
    function renderWith(
      overrides: Partial<Session> = {},
      overridesDomain?: DomainState,
      props: { showRecency?: boolean } = {},
    ) {
      return render(
        <SessionItem
          session={{ ...session, ...overrides }}
          domain={overridesDomain ?? domain}
          agentLabel="devbox-01"
          selected={false}
          onSelect={vi.fn()}
          {...props}
        />,
      );
    }

    it('sets only the workload hint in mono', () => {
      renderWith({ foreground_command: 'claude' });
      const meta = screen.getByTestId('session-item-meta');
      const workload = screen.getByTestId('session-item-workload');

      // The foreground command is the line's one technical string.
      expect(workload).toHaveTextContent('claude');
      expect(workload.className).toMatch(/font-mono/);

      // The line that carries it does not, and neither do the two slots beside
      // it: the node's name and the recency are the Metadata role's own members
      // ("Agent/location, recency"), so the split is a family change and not a
      // re-styling of the line. `textContent` is unchanged by it — the row is
      // still one line reading `{workload} · {agent} · {recency}`.
      expect(meta.className).not.toMatch(/font-mono/);
      expect(meta).toHaveTextContent(/^claude · devbox-01 · /);
    });

    it('keeps the hint slot mono when the command is unreported', () => {
      // `unknown` is the workload slot's documented value
      // (`session-item.md`), not a word about the row — so the family must not
      // flip with the data, or the least informative row would be the one that
      // stops looking like a workload.
      renderWith();
      const workload = screen.getByTestId('session-item-workload');
      expect(workload).toHaveTextContent('unknown');
      expect(workload.className).toMatch(/font-mono/);
      expect(screen.getByTestId('session-item-meta')).toHaveTextContent(
        /^unknown · devbox-01 · /,
      );
    });

    it('drops the recency slot whole when asked, separator included', () => {
      // #1083: a time-grouped list states time once, in the group label. The
      // separator has to go with the slot — leaving it would read
      // `claude · devbox-01 · ` and still look like the three-slot line the
      // Web canary above pins.
      renderWith({ foreground_command: 'claude' }, domain, { showRecency: false });

      const meta = screen.getByTestId('session-item-meta');
      expect(meta).toHaveTextContent(/^claude · devbox-01$/);
      expect(meta.textContent).not.toMatch(/ago|刚刚/);
      // Still one line, still the same testid: the row's identity is unchanged.
      expect(screen.getByTestId('session-item-workload')).toHaveTextContent('claude');
    });

    it('keeps the recency slot by default, so Web cannot move silently', () => {
      // The default is the shipped three-slot line. Asserted here rather than
      // assumed, because `showRecency` is what the App's grouping flips and a
      // default that drifted would change Web's rows with it.
      renderWith({ foreground_command: 'claude' });

      expect(screen.getByTestId('session-item-meta')).toHaveTextContent(
        /^claude · devbox-01 · /,
      );
    });

    it('sets the degraded agent copy in the product face', () => {
      renderWith({}, {
        ...domain,
        agent: { channel: 'offline', copy: 'Agent offline' },
      });
      const copy = screen.getByText('Agent offline');
      // Continuity state about infrastructure — not a command, an ID or a path.
      expect(copy.className).not.toMatch(/font-mono/);
      // Typography is not what changes when the state does; colour is.
      expect(copy.className).toMatch(/text-agent-offline/);
    });
  });

  it('uses design tokens for row spacing', () => {
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    const row = screen.getByTestId('session-item-row');
    expect(row.className).toMatch(/shell-space|var\(--shell-space/);
  });
});

describe('SessionItem settings action', () => {
  it('renders no settings button when onConfigure is absent', () => {
    const onSelect = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
      />,
    );
    expect(screen.queryByTestId(`session-settings-${session.session_id}`)).toBeNull();
  });

  it('calls onConfigure with the session and never selects the row', async () => {
    const onSelect = vi.fn();
    const onConfigure = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
        onConfigure={onConfigure}
      />,
    );
    const button = screen.getByTestId(`session-settings-${session.session_id}`);
    expect(button).toHaveAccessibleName(
      `Configure attach settings for ${session.session_name}`,
    );
    await userEvent.click(button);
    expect(onConfigure).toHaveBeenCalledWith(session);
    expect(onSelect).not.toHaveBeenCalled();
  });

  // jsdom does not apply group-hover; class composition is the assertable contract.
  it('is always interactive below lg and revealed on hover at lg+ (kill parity)', () => {
    const onSelect = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
        onConfigure={vi.fn()}
        onKill={vi.fn()}
      />,
    );
    const settings = screen.getByTestId(`session-settings-${session.session_id}`);
    const kill = screen.getByTestId(`session-kill-${session.session_id}`);
    // No unprefixed hidden state: icons are visible by default below lg. A bare
    // /opacity-0/ regex would also match inside lg:opacity-0, so negatives use
    // token boundaries.
    expect(settings.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(settings.className).not.toMatch(/(^|\s)pointer-events-none(\s|$)/);
    expect(kill.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(kill.className).not.toMatch(/(^|\s)pointer-events-none(\s|$)/);
    // The lg+ reveal chain is gated behind the breakpoint.
    expect(settings.className).toMatch(/lg:opacity-0/);
    expect(settings.className).toMatch(/lg:pointer-events-none/);
    expect(settings.className).toMatch(/lg:group-hover:opacity-100/);
    expect(settings.className).toMatch(/lg:group-hover:pointer-events-auto/);
    expect(kill.className).toMatch(/lg:opacity-0/);
    expect(kill.className).toMatch(/lg:pointer-events-none/);
  });

  it('keeps the icon visible while selected', () => {
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected
        onSelect={vi.fn()}
        onConfigure={vi.fn()}
        onKill={vi.fn()}
      />,
    );
    const settings = screen.getByTestId(`session-settings-${session.session_id}`);
    const kill = screen.getByTestId(`session-kill-${session.session_id}`);
    expect(settings.className).toMatch(/opacity-100/);
    expect(settings.className).toMatch(/pointer-events-auto/);
    // The selected override is lg:-prefixed so tailwind-merge drops the lg:
    // hidden rules — otherwise the hidden state would win the cascade at lg+.
    expect(settings.className).not.toMatch(/lg:opacity-0/);
    expect(kill.className).toMatch(/opacity-100/);
    expect(kill.className).toMatch(/pointer-events-auto/);
    expect(kill.className).not.toMatch(/lg:opacity-0/);
  });
});

/**
 * The sub-`lg` presentation (#1050 stage 2).
 *
 * jsdom applies neither media query nor group-hover, so "which presentation is
 * on screen" is asserted the way the rest of this file asserts reveal: by the
 * class composition that decides it. Whether the two sets are in fact disjoint
 * — exactly one reachable at any width — is a browser property; the class
 * assertions below pin the breakpoint prefix that makes it so, and
 * `ui-contract-matrix.spec.ts` measures the App row.
 */
describe('SessionItem row actions overflow', () => {
  function renderRow({
    selected = false,
    onConfigure,
    onKill,
  }: {
    selected?: boolean;
    onConfigure?: (session: Session) => void;
    onKill?: (session: Session) => void;
  } = {}) {
    return render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={selected}
        onSelect={vi.fn()}
        onConfigure={onConfigure}
        onKill={onKill}
      />,
    );
  }

  /**
   * Open the trigger and return once the popup is interactive — not merely
   * mounted. Base UI keeps one popup node across open/close and holds it inert
   * (`pointer-events: none`) until the open transition settles, so a click
   * issued the moment an item appears can land on a menu still animating in.
   * Same wait as `Shell.test.tsx`'s disclosure helper.
   */
  async function openActions() {
    await userEvent.click(
      screen.getByTestId(`session-actions-${session.session_id}`),
    );
    const menu = await screen.findByRole('menu');
    await waitFor(() => {
      expect(menu).not.toHaveStyle({ pointerEvents: 'none' });
    });
  }

  it('renders no trigger when neither action is available', () => {
    renderRow();
    expect(
      screen.queryByTestId(`session-actions-${session.session_id}`),
    ).toBeNull();
  });

  it('describes the trigger with the session it acts on', () => {
    renderRow({ onKill: vi.fn() });
    expect(
      screen.getByTestId(`session-actions-${session.session_id}`),
    ).toHaveAccessibleName(`Session actions for ${session.session_name}`);
  });

  it('sizes the trigger from the experience control band, not a literal', () => {
    renderRow({ onKill: vi.fn() });
    const trigger = screen.getByTestId(`session-actions-${session.session_id}`);
    // `--control-md` is the row's own band: 32px under the Web shell, 44px
    // inside the App, whose value is `experience.app.touchTarget.min`. A
    // literal here would be right in one experience and a sub-floor tap target
    // in the other — which is what `size-8` on the inline icons is.
    expect(trigger.className).toMatch(/var\(--control-md\)/);
    expect(trigger.className).not.toMatch(/(^|\s)size-\d/);
  });

  it('hands the row from the inline icons to the trigger at lg', () => {
    renderRow({ onConfigure: vi.fn(), onKill: vi.fn() });
    const trigger = screen.getByTestId(`session-actions-${session.session_id}`);
    const settings = screen.getByTestId(`session-settings-${session.session_id}`);
    const kill = screen.getByTestId(`session-kill-${session.session_id}`);
    // Exactly one of the two presentations is displayed at any width: the
    // trigger below lg, the icons at lg+.
    expect(trigger.className).toMatch(/(^|\s)lg:hidden(\s|$)/);
    for (const icon of [settings, kill]) {
      expect(icon.className).toMatch(/(^|\s)max-lg:hidden(\s|$)/);
      expect(icon.className).toMatch(/lg:opacity-0/);
    }
  });

  it('keeps the icons hidden below lg on the selected row too', () => {
    // The selected row overrides the lg+ hidden state with another lg: class.
    // tailwind-merge drops one of two classes only when their modifiers match,
    // so `max-lg:hidden` has to survive that override — if it did not, a
    // selected row would show both presentations at once.
    renderRow({ selected: true, onConfigure: vi.fn(), onKill: vi.fn() });
    const settings = screen.getByTestId(`session-settings-${session.session_id}`);
    const kill = screen.getByTestId(`session-kill-${session.session_id}`);
    expect(settings.className).toMatch(/(^|\s)max-lg:hidden(\s|$)/);
    expect(kill.className).toMatch(/(^|\s)max-lg:hidden(\s|$)/);
  });

  it('opens attach settings without selecting the row', async () => {
    const onSelect = vi.fn();
    const onConfigure = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
        onConfigure={onConfigure}
      />,
    );
    await openActions();
    await userEvent.click(
      await screen.findByTestId(`session-actions-settings-${session.session_id}`),
    );
    expect(onConfigure).toHaveBeenCalledWith(session);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('routes Kill to onKill without selecting the row', async () => {
    const onSelect = vi.fn();
    const onKill = vi.fn();
    render(
      <SessionItem
        session={session}
        domain={domain}
        agentLabel="devbox-01"
        selected={false}
        onSelect={onSelect}
        onKill={onKill}
      />,
    );
    await openActions();
    await userEvent.click(
      await screen.findByTestId(`session-actions-kill-${session.session_id}`),
    );
    expect(onKill).toHaveBeenCalledWith(session);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens from the keyboard and activates an item with it', async () => {
    const onKill = vi.fn();
    renderRow({ onKill });
    const trigger = screen.getByTestId(`session-actions-${session.session_id}`);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await userEvent.keyboard('{Enter}');
    const kill = await screen.findByRole('menuitem', { name: 'Kill session' });
    await waitFor(() => {
      expect(kill).not.toHaveStyle({ pointerEvents: 'none' });
    });
    // Opening moves focus into the popup; Enter on the focused item activates
    // it. Keyboard reachability is the reason `…` was preferred over the swipe
    // and long-press disclosures `session-item.md` also allows.
    //
    // Awaited, not asserted once: Base UI moves focus on the open transition
    // rather than in the key handler, so a bare `toHaveFocus()` here reads the
    // state a frame too early and fails about a third of the time. The item
    // still has to end up focused — this is the claim, not a retry of a
    // different one.
    await waitFor(() => {
      expect(kill).toHaveFocus();
    });
    await userEvent.keyboard('{Enter}');
    expect(onKill).toHaveBeenCalledWith(session);
  });
});

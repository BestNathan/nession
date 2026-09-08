import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsRow } from '@/features/terminal/capsule/CapsuleCommandsRow';
import { QUICK_MOBILE_KEYS } from '@/features/terminal/capsule/physKeys';

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
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

describe('CapsuleCommandsRow', () => {
  it('sends quick key taps', async () => {
    const sendText = vi.fn();
    render(
      <CapsuleCommandsRow
        sendText={sendText}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId('capsule-quick-key-Tab'));
    expect(sendText).toHaveBeenCalledWith('\t');
  });

  it('renders quick mobile keys and More trigger while collapsed', () => {
    render(
      <CapsuleCommandsRow
        sendText={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );

    for (const keyDef of QUICK_MOBILE_KEYS) {
      expect(screen.getByTestId(`capsule-quick-key-${keyDef.label}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('capsule-commands-more')).toBeInTheDocument();
    expect(screen.queryByTestId('phys-key-row')).not.toBeInTheDocument();
  });

  it('toggles commands panel when more trigger is clicked', async () => {
    const onCommandsOpenChange = vi.fn();
    render(
      <CapsuleCommandsRow
        sendText={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={onCommandsOpenChange}
      />,
    );
    await userEvent.click(screen.getByTestId('capsule-commands-more'));
    expect(onCommandsOpenChange).toHaveBeenCalledWith(true);
  });

  it('hides quick keys when open and does not render inline panel', () => {
    render(
      <CapsuleCommandsRow
        sendText={vi.fn()}
        commandsOpen
        onCommandsOpenChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('capsule-commands-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('phys-key-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('capsule-quick-key-Tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('capsule-commands-more')).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps more trigger outside the scrollable quick-key row', () => {
    render(
      <CapsuleCommandsRow
        sendText={vi.fn()}
        commandsOpen={false}
        onCommandsOpenChange={vi.fn()}
      />,
    );
    const more = screen.getByTestId('capsule-commands-more');
    const tab = screen.getByTestId('capsule-quick-key-Tab');
    expect(more.parentElement?.className).toMatch(/shrink-0/);
    expect(tab.parentElement?.className).toMatch(/overflow-x-auto/);
    expect(more.parentElement).not.toBe(tab.parentElement);
  });
});

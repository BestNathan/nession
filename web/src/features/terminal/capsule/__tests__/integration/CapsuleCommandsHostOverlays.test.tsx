import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { CapsuleCommandsHostOverlays } from '@/features/terminal/capsule/components/CapsuleCommandsHostOverlays';
import { CapsuleProvider } from '@/features/terminal/capsule/state/CapsuleProvider';
import { CAPSULE_EXPERIENCE } from '@/features/terminal/capsule/config/experience';
import type { CapsuleContextValue } from '@/features/terminal/capsule/state/capsuleContext';

vi.mock('@/features/commands/hooks/useQuickCommands', () => ({
  useQuickCommands: () => ({
    userCommands: [],
    addCommand: vi.fn().mockResolvedValue(undefined),
    deleteCommand: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/features/terminal/hooks/useCommandHistory', () => ({
  useCommandHistory: () => ({
    addEntry: vi.fn(),
    history: [],
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
    filterHistory: vi.fn().mockReturnValue([]),
  }),
}));

function buildContext(
  commandsOpen: boolean,
  onCommandsOpenChange: (open: boolean) => void,
): CapsuleContextValue {
  return {
    inputValue: '',
    setInputValue: vi.fn(),
    composerLayout: 'flat',
    setComposerLayout: vi.fn(),
    applyLineCount: vi.fn(),
    openPopover: commandsOpen ? 'commands' : null,
    setHistoryOpen: vi.fn(),
    setCommandsOpen: onCommandsOpenChange,
    historyOpen: false,
    commandsOpen,
    mode: 'commands',
    disabled: false,
    send: vi.fn(),
    pasteIntoInput: vi.fn(),
    copyInput: vi.fn().mockResolvedValue(undefined),
    experience: 'app',
    experienceConfig: CAPSULE_EXPERIENCE.app,
    sendText: vi.fn(),
  };
}

function HostFixture({
  commandsOpen,
  onCommandsOpenChange,
}: {
  commandsOpen: boolean;
  onCommandsOpenChange: (open: boolean) => void;
}) {
  const dockRef = useRef<HTMLDivElement>(null);
  return (
    <div
      data-terminal-capsule-host
      style={{
        position: 'relative',
        height: 400,
        ['--composer-commands-panel-max-height' as string]: '40vh',
      }}
    >
      <div ref={dockRef} data-testid="mock-dock" style={{ position: 'absolute', bottom: 0, height: 48, width: '100%' }} />
      <CapsuleProvider value={buildContext(commandsOpen, onCommandsOpenChange)}>
        <CapsuleCommandsHostOverlays dockRef={dockRef} />
      </CapsuleProvider>
    </div>
  );
}

describe('CapsuleCommandsHostOverlays', () => {
  beforeEach(() => {
    vi.stubGlobal('innerHeight', 800);
  });

  it('portals overlay panel and dismiss layer over terminal when open', async () => {
    const onCommandsOpenChange = vi.fn();
    render(<HostFixture commandsOpen onCommandsOpenChange={onCommandsOpenChange} />);

    expect(screen.getByTestId('capsule-commands-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-commands-panel')).toBeInTheDocument();
    expect(screen.getByTestId('phys-key-row')).toBeInTheDocument();
    expect(screen.getByTestId('capsule-commands-dismiss-layer')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('capsule-commands-dismiss-layer'));
    expect(onCommandsOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when closed', () => {
    render(<HostFixture commandsOpen={false} onCommandsOpenChange={vi.fn()} />);
    expect(screen.queryByTestId('capsule-commands-overlay')).not.toBeInTheDocument();
  });
});

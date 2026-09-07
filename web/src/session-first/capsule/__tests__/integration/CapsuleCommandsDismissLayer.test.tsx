import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { CapsuleCommandsDismissLayer } from '@/session-first/capsule/CapsuleCommandsDismissLayer';

function HostFixture({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const dockRef = useRef<HTMLDivElement>(null);
  return (
    <div data-terminal-capsule-host style={{ position: 'relative', height: 400 }}>
      {open ? (
        <CapsuleCommandsDismissLayer dockRef={dockRef} onDismiss={onDismiss} />
      ) : null}
      <div ref={dockRef} data-testid="mock-dock" style={{ position: 'absolute', bottom: 0, height: 120, width: '100%' }} />
    </div>
  );
}

describe('CapsuleCommandsDismissLayer', () => {
  it('calls onDismiss when terminal area above dock is clicked', async () => {
    const onDismiss = vi.fn();
    render(<HostFixture open onDismiss={onDismiss} />);
    const layer = screen.getByTestId('capsule-commands-dismiss-layer');
    expect(layer).toBeInTheDocument();
    await userEvent.click(layer);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not render when closed', () => {
    render(<HostFixture open={false} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('capsule-commands-dismiss-layer')).not.toBeInTheDocument();
  });
});

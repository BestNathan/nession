import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapsuleCommandsDismissLayer } from '@/session-first/capsule/CapsuleCommandsDismissLayer';

describe('CapsuleCommandsDismissLayer', () => {
  it('calls onDismiss when terminal area above panel is clicked', async () => {
    const onDismiss = vi.fn();
    render(
      <div data-terminal-capsule-host style={{ position: 'relative', height: 400 }}>
        <CapsuleCommandsDismissLayer bottomPx={160} onDismiss={onDismiss} />
      </div>,
    );
    const layer = screen.getByTestId('capsule-commands-dismiss-layer');
    expect(layer).toHaveStyle({ bottom: '160px' });
    await userEvent.click(layer);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

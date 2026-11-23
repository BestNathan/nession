import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppFilesSelectionBottomBar } from '@/app/experiences/app/AppFilesSelectionChrome';

/**
 * #4115 SC-03: the action row itself keeps Files' disabled semantics. The Host
 * owns only the band's placement and Capsule/safe-area inset; when the
 * selection is empty (count 0) both actions must still refuse the action.
 */
describe('AppFilesSelectionBottomBar', () => {
  it('keeps Copy and Delete disabled when the selection is empty', () => {
    render(<AppFilesSelectionBottomBar onCopy={vi.fn()} onDelete={vi.fn()} disabled />);

    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('enables the actions for a nonempty selection and keeps their handlers', () => {
    const onCopy = vi.fn();
    const onDelete = vi.fn();
    render(
      <AppFilesSelectionBottomBar onCopy={onCopy} onDelete={onDelete} disabled={false} />,
    );

    screen.getByRole('button', { name: 'Copy' }).click();
    screen.getByRole('button', { name: 'Delete' }).click();

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not own the band or its safe-area/Capsule padding (#4115)', () => {
    render(<AppFilesSelectionBottomBar onCopy={vi.fn()} onDelete={vi.fn()} disabled={false} />);

    const row = screen.getByTestId('files-app-selection-bottom');
    // The Host slot paints the border/ground and spends the measured inset.
    expect(row.className).not.toContain('border-t');
    expect(row.className).not.toContain('bg-background');
    expect(row.className).not.toContain('safe-area');
    expect(row.className).not.toContain('workspace-content-bottom-inset');
  });
});

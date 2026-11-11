import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

describe('Dialog three-zone anatomy', () => {
  it('renders the header, body and footer as one ordered surface', () => {
    render(
      <Dialog open>
        <DialogContent data-testid="anatomy-dialog">
          <DialogHeader>
            <DialogTitle>Anatomy</DialogTitle>
          </DialogHeader>
          <DialogBody data-testid="anatomy-body">Fields</DialogBody>
          <DialogFooter>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByTestId('anatomy-dialog');
    const header = dialog.querySelector('[data-slot="dialog-header"]');
    const body = screen.getByTestId('anatomy-body');
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');

    expect(header).not.toBeNull();
    expect(body).toHaveAttribute('data-slot', 'dialog-body');
    expect(footer).not.toBeNull();
    // One ordered shell: Header → Body → Footer. The footer is not a second
    // floating layer and no consumer owns a second scroll body.
    expect(header!.nextElementSibling).toBe(body);
    expect(body.nextElementSibling).toBe(footer);
    expect(body).toHaveTextContent('Fields');
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Save' }));
  });
});

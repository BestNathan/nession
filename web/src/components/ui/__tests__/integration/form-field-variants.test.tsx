import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select, SelectTrigger } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

describe('compact form-field variants (#3136)', () => {
  it('gives a single-line Select the Experience control band', () => {
    render(
      <Select>
        <SelectTrigger size="field">devbox-01</SelectTrigger>
      </Select>,
    );
    const trigger = screen.getByText('devbox-01').closest('[data-slot="select-trigger"]')!;
    expect(trigger).toHaveAttribute('data-size', 'field');
    expect(trigger.className).toContain('min-h-[length:var(--nession-control-md)]');
    expect(trigger.className).toContain('py-1');
    expect(trigger.className).not.toContain('h-8');
  });

  it('starts a growing Directory field on the same band and keeps the default unchanged', () => {
    render(<Textarea variant="field" rows={1} aria-label="Directory" />);
    const field = screen.getByLabelText('Directory');
    expect(field).toHaveAttribute('data-variant', 'field');
    expect(field).toHaveAttribute('rows', '1');
    expect(field.className).toContain('min-h-[length:var(--nession-control-md)]');
    expect(field.className).toContain('field-sizing-content');
    expect(field.className).not.toContain('min-h-16');

    render(<Textarea aria-label="Description" />);
    const standard = screen.getByLabelText('Description');
    expect(standard).toHaveAttribute('data-variant', 'default');
    expect(standard.className).toContain('min-h-16');
  });
});

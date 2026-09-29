import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JsonTree } from '@/components/json/JsonTree';

describe('JsonTree', () => {
  it('compact mode bounds object field preview', () => {
    const value = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
    };
    render(<JsonTree value={value} mode="compact" />);
    expect(screen.getByText(/\+1 more fields/)).toBeInTheDocument();
  });

  it('inspector mode exposes tree semantics and disclosure', async () => {
    const value = { nested: { secret: 1 } };
    render(<JsonTree value={value} mode="inspector" />);
    expect(screen.getByRole('tree')).toBeInTheDocument();
    const items = screen.getAllByRole('treeitem');
    expect(items.length).toBeGreaterThan(0);
    const expand = screen.getByRole('button', { name: 'Expand' });
    await userEvent.click(expand);
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
  });
});

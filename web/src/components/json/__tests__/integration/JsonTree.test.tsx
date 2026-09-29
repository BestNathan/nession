import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JsonTree } from '@/components/json/JsonTree';
import { JsonScalar } from '@/components/json/JsonScalar';
import { COMPACT_STRING_CHARS } from '@/components/json/jsonTreeLimits';

describe('JsonTree', () => {
  it('compact mode renders root object as one inline line', () => {
    render(<JsonTree value={{ id: 123, name: 'abc' }} mode="compact" />);
    expect(screen.getByText(/"id"/)).toBeInTheDocument();
    expect(screen.getByText(/123/)).toBeInTheDocument();
    expect(screen.queryByText(/more fields/)).not.toBeInTheDocument();
  });

  it('compact mode bounds object field preview', () => {
    const value = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
    };
    render(<JsonTree value={value} mode="compact" />);
    expect(screen.getByText(/… \+1/)).toBeInTheDocument();
  });

  it('compact mode truncates long strings before render (#1199)', () => {
    const long = 'z'.repeat(COMPACT_STRING_CHARS + 500);
    render(<JsonTree value={{ note: long }} mode="compact" />);
    expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
    expect(document.body.textContent?.includes(long)).toBe(false);
    expect(document.body.textContent).toMatch(/…/);
  });

  it('JsonScalar compact mode truncates without expand control', () => {
    const long = 'a'.repeat(200);
    render(<JsonScalar value={long} />);
    expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
    expect(document.body.textContent?.includes(long)).toBe(false);
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

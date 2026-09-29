import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JsonPreview } from '@/capabilities/files/components/JsonPreview';
import { JsonlPreview } from '@/capabilities/files/components/JsonlPreview';

describe('JsonPreview', () => {
  it('renders parsed structure', () => {
    render(<JsonPreview content='{"tags":["a","b"]}' />);
    expect(screen.getByText('"tags"')).toBeInTheDocument();
    expect(screen.getByText('"a"')).toBeInTheDocument();
  });
});

describe('JsonlPreview', () => {
  it('keeps malformed lines local', () => {
    render(<JsonlPreview content={'{"ok":true}\n{bad\n{"n":2}'} />);
    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
    expect(screen.getByText('Line 3')).toBeInTheDocument();
  });
});

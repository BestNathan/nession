import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UnsupportedView } from '@/components/UnsupportedView';

describe('UnsupportedView', () => {
  it('renders "Preview not supported" message', () => {
    render(<UnsupportedView filename="app.exe" />);
    expect(screen.getByText('Preview not supported')).toBeTruthy();
  });

  it('shows the filename', () => {
    render(<UnsupportedView filename="app.exe" />);
    expect(screen.getByText('app.exe')).toBeTruthy();
  });

  it('renders the FileWarning icon', () => {
    const { container } = render(<UnsupportedView filename="app.exe" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('works with different filenames', () => {
    render(<UnsupportedView filename="archive.zip" />);
    expect(screen.getByText('archive.zip')).toBeTruthy();
    expect(screen.getByText('Preview not supported')).toBeTruthy();
  });
});

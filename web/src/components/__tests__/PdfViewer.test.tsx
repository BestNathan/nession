import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PdfViewer } from '../PdfViewer';

vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:pdf-url'),
  revokeObjectURL: vi.fn(),
});

describe('PdfViewer', () => {
  it('renders an embed element with the blob URL', () => {
    render(<PdfViewer blobUrl="blob:pdf-url" filename="doc.pdf" />);
    const embed = screen.getByTestId('pdf-viewer');
    expect(embed).toBeTruthy();
    expect(embed.tagName).toBe('EMBED');
    expect(embed.getAttribute('src')).toBe('blob:pdf-url');
    expect(embed.getAttribute('type')).toBe('application/pdf');
  });

  it('shows the filename', () => {
    render(<PdfViewer blobUrl="blob:pdf-url" filename="doc.pdf" />);
    expect(screen.getByText('doc.pdf')).toBeTruthy();
  });
});

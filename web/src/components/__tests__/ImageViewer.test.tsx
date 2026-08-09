import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageViewer } from '../ImageViewer';

const mockBlobUrl = 'blob:test-url';
vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => mockBlobUrl),
  revokeObjectURL: vi.fn(),
});

describe('ImageViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an image with the given blob URL', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    const img = screen.getByRole('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe(mockBlobUrl);
  });

  it('shows the filename in the toolbar', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    expect(screen.getByText('photo.png')).toBeTruthy();
  });

  it('has zoom-in button that increases scale', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    const zoomIn = screen.getByLabelText('Zoom in');
    fireEvent.click(zoomIn);
    expect(screen.getAllByText('110%').length).toBeGreaterThan(0);
  });

  it('has zoom-out button that decreases scale', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    const zoomOut = screen.getByLabelText('Zoom out');
    fireEvent.click(zoomOut);
    const img = screen.getByRole('img');
    expect(img.style.transform).toBe('scale(0.9)');
  });

  it('toggles fit-to-screen mode', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    const fitBtn = screen.getByLabelText('Fit to screen');
    fireEvent.click(fitBtn);
    const img = screen.getByRole('img');
    expect(img.className).toContain('object-contain');
  });

  it('renders the zoom percentage', () => {
    render(<ImageViewer blobUrl={mockBlobUrl} filename="photo.png" />);
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
  });
});

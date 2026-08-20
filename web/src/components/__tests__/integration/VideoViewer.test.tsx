import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VideoViewer } from '@/components/VideoViewer';

vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:video-url'),
  revokeObjectURL: vi.fn(),
});

describe('VideoViewer', () => {
  it('renders a video element with controls and the blob URL', () => {
    render(<VideoViewer blobUrl="blob:video-url" filename="demo.mp4" />);
    const video = screen.getByTestId('video-viewer');
    expect(video).toBeTruthy();
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toBe('blob:video-url');
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('shows the filename', () => {
    render(<VideoViewer blobUrl="blob:video-url" filename="demo.mp4" />);
    expect(screen.getByText('demo.mp4')).toBeTruthy();
  });
});

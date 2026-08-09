import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AudioViewer } from '../AudioViewer';

vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:audio-url'),
  revokeObjectURL: vi.fn(),
});

describe('AudioViewer', () => {
  it('renders an audio element with controls and the blob URL', () => {
    render(<AudioViewer blobUrl="blob:audio-url" filename="song.mp3" />);
    const audio = screen.getByTestId('audio-viewer');
    expect(audio).toBeTruthy();
    expect(audio.tagName).toBe('AUDIO');
    expect(audio.getAttribute('src')).toBe('blob:audio-url');
    expect(audio.hasAttribute('controls')).toBe(true);
  });

  it('shows the filename', () => {
    render(<AudioViewer blobUrl="blob:audio-url" filename="song.mp3" />);
    expect(screen.getByText('song.mp3')).toBeTruthy();
  });
});

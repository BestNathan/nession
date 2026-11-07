import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FileContentViewer } from '../../FileContentViewer';
import type { FileSourceEditorProps, FileViewData } from '../../types';

function FakeEditor({ value }: FileSourceEditorProps) {
  return <textarea data-testid="fake-source" readOnly value={value} />;
}

function renderViewer(
  data: FileViewData,
  path: string,
  mode?: 'auto' | 'preview' | 'source',
) {
  return render(
    <FileContentViewer
      file={{ path }}
      data={data}
      sourceEditor={FakeEditor}
      mode={mode}
    />,
  );
}

describe('FileContentViewer (#2876)', () => {
  it('renders code text in the supplied read-only source editor', () => {
    renderViewer({ kind: 'text', text: 'export const x = 1;\n', complete: true }, 'src/x.ts');
    const source = screen.getByTestId('fake-source');
    expect(source).toHaveValue('export const x = 1;\n');
    expect(source).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('offers a complete JSON preview and returns to source through Raw', async () => {
    const user = userEvent.setup();
    renderViewer(
      { kind: 'text', text: '{"name":"git-viewer","items":[1,2]}', complete: true },
      'notes/data.json',
    );

    expect(screen.getByRole('tree')).toBeInTheDocument();
    expect(screen.getByText('"name"')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByTestId('fake-source')).toHaveValue(
      '{"name":"git-viewer","items":[1,2]}',
    );
    expect(screen.getByRole('button', { name: 'Raw', pressed: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });

  it('never offers a structured preview for incomplete content', () => {
    renderViewer(
      { kind: 'text', text: '{"name":"truncated"', complete: false },
      'notes/truncated.json',
    );
    expect(screen.getByTestId('file-view-incomplete')).toHaveTextContent(
      'Preview unavailable for incomplete content',
    );
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByTestId('fake-source')).toHaveValue('{"name":"truncated"');
  });

  it('keeps invalid JSON usable through its raw source', async () => {
    const user = userEvent.setup();
    renderViewer(
      { kind: 'text', text: '{ "broken": true, }', complete: true },
      'notes/broken.json',
    );
    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByTestId('fake-source')).toHaveValue('{ "broken": true, }');
  });

  it('renders a text file named like an image as source, not an image', () => {
    renderViewer({ kind: 'text', text: 'plain text', complete: true }, 'assets/fake.png');
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument();
    expect(screen.getByTestId('fake-source')).toHaveValue('plain text');
  });

  it('renders authorized media through the existing viewer leaves', () => {
    const { rerender } = renderViewer(
      { kind: 'media', url: 'blob:image', mimeType: 'image/png', complete: true },
      'assets/photo.png',
    );
    expect(screen.getByTestId('image-viewer')).toHaveAttribute('src', 'blob:image');

    rerender(
      <FileContentViewer
        file={{ path: 'assets/sample.webm' }}
        data={{ kind: 'media', url: 'blob:video', mimeType: 'video/webm', complete: true }}
        sourceEditor={FakeEditor}
      />,
    );
    expect(screen.getByTestId('video-viewer')).toHaveAttribute('src', 'blob:video');

    rerender(
      <FileContentViewer
        file={{ path: 'assets/sample.wav' }}
        data={{ kind: 'media', url: 'blob:audio', mimeType: 'audio/wav', complete: true }}
        sourceEditor={FakeEditor}
      />,
    );
    expect(screen.getByTestId('audio-viewer')).toHaveAttribute('src', 'blob:audio');

    rerender(
      <FileContentViewer
        file={{ path: 'assets/spec.pdf' }}
        data={{ kind: 'media', url: 'blob:pdf', mimeType: 'application/pdf', complete: true }}
        sourceEditor={FakeEditor}
      />,
    );
    expect(screen.getByTestId('pdf-viewer')).toHaveAttribute('src', 'blob:pdf');
  });

  it('shows the caller-provided unavailable reason without a fake preview', () => {
    renderViewer(
      { kind: 'unavailable', reason: 'This file is too large for a bounded media preview.' },
      'assets/oversized.png',
    );
    expect(screen.getByTestId('file-view-unavailable')).toHaveTextContent(
      'too large for a bounded media preview',
    );
    expect(screen.queryByTestId('fake-source')).not.toBeInTheDocument();
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument();
  });
});

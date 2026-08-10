import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileViewer } from '../FileViewer';
import type { FileOps } from '../../services/fileOps';

function mockFileOps(overrides: Partial<FileOps> = {}): FileOps {
  return {
    readFile: vi.fn().mockResolvedValue({
      path: '/test/readme.md',
      content: btoa('# Hello\n\nThis is markdown.\n\n- item 1\n- item 2'),
      mime_type: 'text/markdown',
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    base64Decode: (b64: string) => atob(b64),
    ...overrides,
  } as unknown as FileOps;
}

describe('FileViewer markdown integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Preview button for .md files', async () => {
    const ops = mockFileOps();
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/readme.md" filename="readme.md" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });
  });

  it('renders markdown content in preview mode by default for .md files', async () => {
    const ops = mockFileOps();
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/readme.md" filename="readme.md" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeInTheDocument();
      expect(screen.getByText('This is markdown.')).toBeInTheDocument();
    });
  });

  it('toggles between Preview and Raw mode', async () => {
    const ops = mockFileOps();
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/readme.md" filename="readme.md" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });

    // Click Raw to switch from preview to raw view mode
    await userEvent.click(screen.getByText('Raw'));

    // Edit button appears only in raw view mode — proves the mode changed
    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });

    // Switch back to preview
    await userEvent.click(screen.getByText('Preview'));

    // Edit button hidden again in preview mode
    await waitFor(() => {
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });
  });

  it('dismisses suggestion banner and hides preview UI after dismiss', async () => {
    const content = `# Just a comment

echo "hello world"

# Another comment
`;
    const ops = mockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/script',
        content: btoa(content),
        mime_type: 'text/plain',
      }),
    });
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/script" filename="script" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText(/looks like Markdown/i)).toBeInTheDocument();
    });

    // Dismiss the suggestion
    await userEvent.click(screen.getByLabelText('Dismiss'));

    await waitFor(() => {
      expect(screen.queryByText(/looks like Markdown/i)).not.toBeInTheDocument();
    });
  });

  it('does NOT show Preview button for .txt files', async () => {
    const ops = mockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/notes.txt',
        content: btoa('Just some text.'),
        mime_type: 'text/plain',
      }),
    });
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/notes.txt" filename="notes.txt" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.queryByText('Preview')).not.toBeInTheDocument();
      expect(screen.queryByText('Raw')).not.toBeInTheDocument();
    });
  });

  it('auto-detects markdown in extensionless files with high confidence', async () => {
    const content = `# Project Title

## Getting Started

- Step one
- Step two

See the [docs](https://example.com).

\`\`\`bash
npm start
\`\`\`
`;
    const ops = mockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/README',
        content: btoa(content),
        mime_type: 'text/plain',
      }),
    });
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/README" filename="README" onClose={onClose} />);

    await waitFor(() => {
      // Should auto-detect and show preview
      expect(screen.getByText('Project Title')).toBeInTheDocument();
    });
  });

  it('shows suggestion banner for medium confidence detection', async () => {
    const content = `# Just a comment

echo "hello world"

# Another comment
`;
    const ops = mockFileOps({
      readFile: vi.fn().mockResolvedValue({
        path: '/test/script',
        content: btoa(content),
        mime_type: 'text/plain',
      }),
    });
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/script" filename="script" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText(/looks like Markdown/i)).toBeInTheDocument();
    });
  });

  it('hides Edit button when in preview mode', async () => {
    const ops = mockFileOps();
    const onClose = vi.fn();
    render(<FileViewer fileOps={ops} path="/test/readme.md" filename="readme.md" onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument();
    });
    // Edit button should not be visible in preview mode
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });
});

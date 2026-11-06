import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryView } from '../../MemoryView';
import type { MemoryState } from '../../../hooks/useMemory';
import type { ClaudeCodeMemoryResponse } from '../../../types';

function state(overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    response: null,
    files: [],
    loading: false,
    error: null,
    selectedPath: null,
    content: '',
    contentType: '',
    totalSize: 0,
    hasMore: false,
    nextOffset: 0,
    readLoading: false,
    readError: null,
    loadedPath: null,
    ...overrides,
  };
}

function readyResponse(
  files: Array<{ path: string; size?: number }>,
  directory = '/home/u/.claude/projects/-work-repo/memory',
): ClaudeCodeMemoryResponse {
  return {
    state: 'ready',
    repository_root: '/work/repo',
    repository_kind: 'git',
    memory_directory: directory,
    files: files.map((file) => ({
      path: file.path,
      size: file.size ?? 100,
      content_type: 'markdown',
    })),
    truncated: false,
  };
}

function renderMemory(memory: MemoryState) {
  const onOpenFile = vi.fn<(path: string) => void>();
  const onLoadMore = vi.fn();
  const onRetry = vi.fn();
  const onRetryRead = vi.fn();
  const view = render(
    <MemoryView
      memory={memory}
      onOpenFile={onOpenFile}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      onRetryRead={onRetryRead}
    />,
  );
  return {
    onOpenFile,
    onLoadMore,
    onRetry,
    onRetryRead,
    container: view.container,
    rerender: (next: MemoryState) =>
      view.rerender(
        <MemoryView
          memory={next}
          onOpenFile={onOpenFile}
          onLoadMore={onLoadMore}
          onRetry={onRetry}
          onRetryRead={onRetryRead}
        />,
      ),
  };
}

const scrollIntoView = vi.fn();
beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView as typeof Element.prototype.scrollIntoView;
});

const unavailable: ClaudeCodeMemoryResponse = {
  state: 'unavailable',
  files: [],
  truncated: false,
};

describe('MemoryView', () => {
  it('keeps every provider state as its own sentence', () => {
    const cases: Array<[ClaudeCodeMemoryResponse, RegExp]> = [
      [unavailable, /working directory is not available/],
      [
        { state: 'no_memory', files: [], truncated: false },
        /has no Claude Code Auto Memory yet/,
      ],
      [
        { state: 'disabled', files: [], truncated: false },
        /turned off/,
      ],
      [
        {
          state: 'unsupported_override',
          error: 'autoMemoryDirectory is set in .claude/settings.json',
          files: [],
          truncated: false,
        },
        /cannot verify/,
      ],
      [
        { state: 'error', error: 'permission denied', files: [], truncated: false },
        /could not be read/,
      ],
    ];

    for (const [response, sentence] of cases) {
      renderMemory(state({ response }));
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(screen.getByTestId('claude-code-memory')).toHaveAttribute(
        'data-state',
        response.state,
      );
      expect(screen.queryByTestId('claude-code-memory-list')).toBeNull();
      cleanup();
    }
  });

  it('shows the resolved source and opens the selected file', () => {
    const response = readyResponse([{ path: 'MEMORY.md' }, { path: 'feedback.md' }]);
    const { onOpenFile } = renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'MEMORY.md',
        content: '# Index',
        contentType: 'markdown',
        totalSize: 7,
        loadedPath: 'MEMORY.md',
      }),
    );

    expect(screen.getByTestId('claude-code-memory-source')).toHaveTextContent('/work/repo');
    expect(screen.getByRole('heading', { name: 'Index' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'feedback.md' }));
    expect(onOpenFile).toHaveBeenCalledWith('feedback.md');
  });

  it('a no_memory answer still names where it looked', () => {
    renderMemory(
      state({
        response: {
          state: 'no_memory',
          repository_root: '/work/repo',
          repository_kind: 'project_root',
          memory_directory: '/work/repo/.claude/memory',
          files: [],
          truncated: false,
        },
      }),
    );
    expect(screen.getByText(/has no Claude Code Auto Memory yet/)).toBeInTheDocument();
    expect(screen.getByText(/not a Git repository/)).toBeInTheDocument();
  });

  it('offers a retry for a transport failure and for a failed read', () => {
    const transport = renderMemory(state({ error: 'socket closed' }));
    fireEvent.click(screen.getByTestId('claude-code-memory-retry'));
    expect(transport.onRetry).toHaveBeenCalledTimes(1);
    cleanup();

    const response = readyResponse([{ path: 'MEMORY.md' }]);
    const read = renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'MEMORY.md',
        readError: 'access_denied',
      }),
    );
    fireEvent.click(screen.getByTestId('claude-code-memory-read-retry'));
    expect(read.onRetryRead).toHaveBeenCalledTimes(1);
  });

  it('renders Memory Markdown as a document, not raw text', () => {
    const response = readyResponse([{ path: 'MEMORY.md' }]);
    const content = [
      '---',
      'title: Architecture constraints',
      'owner: nessionion',
      '---',
      '',
      '# Architecture',
      '',
      '## Session boundary',
      '',
      '**Session** owns context and `tmux` runs the terminal.',
      '',
      '| Concept | Owner |',
      '| --- | --- |',
      '| Repository | Session |',
      '',
      '- [x] read-only',
      '- [ ] writes',
      '',
      '```rust',
      'fn main() {}',
      '```',
    ].join('\n');
    const { container } = render(
      <MemoryView
        memory={state({
          response,
          files: response.files,
          selectedPath: 'MEMORY.md',
          content,
          contentType: 'markdown',
          totalSize: content.length,
          loadedPath: 'MEMORY.md',
        })}
        onOpenFile={vi.fn()}
        onLoadMore={vi.fn()}
        onRetry={vi.fn()}
        onRetryRead={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Architecture' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Session boundary' })).toBeInTheDocument();
    expect(screen.getByText('tmux')).toBeInTheDocument();
    expect(container.querySelector('table.nession-frontmatter')).toHaveTextContent(
      'Architecture constraints',
    );
    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.textContent).toContain('fn main');
    expect(screen.queryByTestId('claude-code-memory-raw')).toBeNull();
  });

  it('renders TOML frontmatter as metadata and keeps malformed frontmatter body visible', () => {
    const response = readyResponse([{ path: 'interaction.md' }, { path: 'broken.md' }]);
    const toml = [
      '+++',
      'title = "Interaction principles"',
      'status = "approved"',
      '+++',
      '',
      '# Interaction',
    ].join('\n');
    const { container, rerender } = renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'interaction.md',
        content: toml,
        loadedPath: 'interaction.md',
      }),
    );
    expect(container.querySelector('table.nession-frontmatter')).toHaveTextContent(
      'Interaction principles',
    );
    expect(screen.getByRole('heading', { name: 'Interaction' })).toBeInTheDocument();

    const broken = '---\ntitle: unclosed\n# Body still readable';
    rerender(
      state({
        response,
        files: response.files,
        selectedPath: 'broken.md',
        content: broken,
        loadedPath: 'broken.md',
      }),
    );
    expect(screen.getByRole('heading', { name: 'Body still readable' })).toBeInTheDocument();
  });

  it('opens a listed relative topic and scrolls to its fragment after render', () => {
    const response = readyResponse([{ path: 'MEMORY.md' }, { path: 'architecture.md' }]);
    const index = '[Architecture](architecture.md#session-boundary)';
    const harness = renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'MEMORY.md',
        content: index,
        loadedPath: 'MEMORY.md',
      }),
    );

    fireEvent.click(screen.getByRole('link', { name: 'Architecture' }));
    expect(harness.onOpenFile).toHaveBeenCalledWith('architecture.md');

    const architecture = '# Architecture\n\n## Session boundary\n\nText';
    harness.rerender(
      state({
        response,
        files: response.files,
        selectedPath: 'architecture.md',
        content: architecture,
        loadedPath: 'architecture.md',
      }),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('claude-code-memory-link-notice')).toBeNull();
  });

  it('scrolls within the current document for a fragment-only link', () => {
    const response = readyResponse([{ path: 'architecture.md' }]);
    const content =
      '# Architecture\n\n## Session boundary\n\n[Boundary](#session-boundary)';
    renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'architecture.md',
        content,
        loadedPath: 'architecture.md',
      }),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Boundary' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('reports an unlisted target without leaving the current document', () => {
    const response = readyResponse([{ path: 'MEMORY.md' }]);
    const harness = renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'MEMORY.md',
        content: '[Missing](missing.md)',
        loadedPath: 'MEMORY.md',
      }),
    );

    fireEvent.click(screen.getByRole('link', { name: 'Missing' }));
    expect(harness.onOpenFile).not.toHaveBeenCalled();
    expect(screen.getByTestId('claude-code-memory-link-notice')).toHaveTextContent(
      'not a Markdown file in this Memory snapshot',
    );
  });

  it('blocks traversal and unsafe links while keeping external links safe', () => {
    const response = readyResponse([{ path: 'MEMORY.md' }]);
    const content = [
      '[Escape](../private.md)',
      '',
      '[Unsafe](javascript:alert(1))',
      '',
      '[Docs](https://code.claude.com/docs/en/memory)',
    ].join('\n');
    const harness = renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'MEMORY.md',
        content,
        loadedPath: 'MEMORY.md',
      }),
    );

    fireEvent.click(screen.getByRole('link', { name: 'Escape' }));
    expect(harness.onOpenFile).not.toHaveBeenCalled();
    expect(screen.getByTestId('claude-code-memory-link-notice')).toHaveTextContent(
      'leave the Memory directory',
    );

    const unsafe = screen.queryByRole('link', { name: 'Unsafe' });
    if (unsafe) {
      fireEvent.click(unsafe);
      expect(harness.onOpenFile).not.toHaveBeenCalled();
    }

    const docs = screen.getByRole('link', { name: 'Docs' });
    expect(docs).toHaveAttribute('href', 'https://code.claude.com/docs/en/memory');
    expect(docs).toHaveAttribute('target', '_blank');
    expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('reports a fragment missing from a partial file and never guesses a heading', () => {
    const response = readyResponse([{ path: 'MEMORY.md' }, { path: 'long.md' }]);
    const harness = renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'MEMORY.md',
        content: '[Long](long.md#after-loading)',
        loadedPath: 'MEMORY.md',
      }),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Long' }));
    expect(harness.onOpenFile).toHaveBeenCalledWith('long.md');

    harness.rerender(
      state({
        response,
        files: response.files,
        selectedPath: 'long.md',
        content: '# Long\n\n## First section\n',
        hasMore: true,
        loadedPath: 'long.md',
      }),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByTestId('claude-code-memory-partial')).toBeInTheDocument();
    expect(screen.getByTestId('claude-code-memory-link-notice')).toHaveTextContent(
      'not in the loaded part',
    );

    // The deferred target survives the continuation and scrolls once it renders.
    harness.rerender(
      state({
        response,
        files: response.files,
        selectedPath: 'long.md',
        content: '# Long\n\n## First section\n\n## After loading\n',
        hasMore: false,
        loadedPath: 'long.md',
      }),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('claude-code-memory-link-notice')).toBeNull();
  });

  it('drops a pending fragment and notice when the Session moves repository', () => {
    const first = readyResponse([{ path: 'MEMORY.md' }, { path: 'architecture.md' }]);
    const harness = renderMemory(
      state({
        response: first,
        files: first.files,
        selectedPath: 'MEMORY.md',
        content: '[Missing](missing.md)',
        loadedPath: 'MEMORY.md',
      }),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Missing' }));
    expect(screen.getByTestId('claude-code-memory-link-notice')).toBeInTheDocument();

    const moved = readyResponse(
      [{ path: 'MEMORY.md' }],
      '/home/u/.claude/projects/-work-scratch/memory',
    );
    harness.rerender(
      state({
        response: moved,
        files: moved.files,
        selectedPath: 'MEMORY.md',
        content: '# Scratch\n\nNo topics here',
        loadedPath: 'MEMORY.md',
      }),
    );
    expect(screen.queryByTestId('claude-code-memory-link-notice')).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Scratch' })).toBeInTheDocument();
  });

  it('toggles between rendered preview and raw source', () => {
    const response = readyResponse([{ path: 'MEMORY.md' }]);
    renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'MEMORY.md',
        content: '# Index\n\nSome **strong** text.',
        loadedPath: 'MEMORY.md',
      }),
    );
    expect(screen.getByRole('heading', { name: 'Index' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('claude-code-memory-mode-raw'));
    expect(screen.getByTestId('claude-code-memory-raw')).toHaveTextContent('# Index');
    expect(screen.queryByRole('heading', { name: 'Index' })).toBeNull();

    fireEvent.click(screen.getByTestId('claude-code-memory-mode-preview'));
    expect(screen.getByRole('heading', { name: 'Index' })).toBeInTheDocument();
  });

  it('keeps the rendered document inside a scrollable surface', () => {
    const response = readyResponse([{ path: 'MEMORY.md' }]);
    renderMemory(
      state({
        response,
        files: response.files,
        selectedPath: 'MEMORY.md',
        content: '# Index',
        loadedPath: 'MEMORY.md',
      }),
    );
    const content = screen.getByTestId('claude-code-memory-content');
    expect(content.className).toContain('overflow-y-auto');
    expect(within(content).getByRole('heading', { name: 'Index' })).toBeInTheDocument();
  });
});

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

function renderMemory(memory: MemoryState) {
  const onOpenFile = vi.fn<(path: string) => void>();
  const onLoadMore = vi.fn();
  const onRetry = vi.fn();
  const onRetryRead = vi.fn();
  render(
    <MemoryView
      memory={memory}
      onOpenFile={onOpenFile}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      onRetryRead={onRetryRead}
    />,
  );
  return { onOpenFile, onLoadMore, onRetry, onRetryRead };
}

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
    const response: ClaudeCodeMemoryResponse = {
      state: 'ready',
      repository_root: '/work/repo',
      repository_kind: 'git',
      memory_directory: '/home/u/.claude/projects/-work-repo/memory',
      files: [
        { path: 'MEMORY.md', size: 7, content_type: 'markdown' },
        { path: 'feedback.md', size: 9, content_type: 'markdown' },
      ],
      truncated: false,
    };
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
    expect(screen.getByText('# Index')).toBeInTheDocument();
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

    const response: ClaudeCodeMemoryResponse = {
      state: 'ready',
      repository_root: '/work/repo',
      repository_kind: 'git',
      files: [{ path: 'MEMORY.md', size: 7, content_type: 'markdown' }],
      truncated: false,
    };
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
});

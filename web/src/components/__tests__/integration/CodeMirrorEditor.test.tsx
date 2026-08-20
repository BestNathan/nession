import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { CodeMirrorEditor, type CodeMirrorEditorProps } from '@/components/CodeMirrorEditor';

function renderEditor(props: Partial<CodeMirrorEditorProps> = {}) {
  const onChange = vi.fn();
  const defaults: CodeMirrorEditorProps = {
    value: 'hello world',
    onChange,
    readOnly: false,
    filename: 'test.js',
  };
  const utils = render(<CodeMirrorEditor {...defaults} {...props} />);
  return { onChange, ...utils };
}

async function waitForEditor() {
  await waitFor(() => {
    expect(document.querySelector('.cm-editor')).toBeTruthy();
  });
}

function getEditorView(): EditorView {
  const editor = document.querySelector('.cm-editor');
  expect(editor).toBeTruthy();
  const view = EditorView.findFromDOM(editor as HTMLElement);
  expect(view).toBeTruthy();
  return view as EditorView;
}

function dispatchKey(
  target: HTMLElement,
  init: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('CodeMirrorEditor', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders an editor with the initial value', async () => {
    renderEditor({ value: 'console.log("hi")' });
    await waitForEditor();
    const content = document.querySelector('.cm-content');
    expect(content?.textContent).toContain('console.log("hi")');
  });

  it('renders with empty value', async () => {
    renderEditor({ value: '' });
    await waitForEditor();
    expect(document.querySelector('.cm-content')).toBeTruthy();
  });

  it('applies readonly mode', async () => {
    renderEditor({ value: 'readonly text', readOnly: true });
    await waitForEditor();
    const content = document.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('false');
  });

  it('renders editable by default', async () => {
    renderEditor({ value: 'editable text', readOnly: false });
    await waitForEditor();
    const content = document.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('true');
  });

  it('has the CodeMirror editor container', async () => {
    renderEditor();
    await waitForEditor();
    expect(document.querySelector('[data-testid="codemirror-editor"]')).toBeTruthy();
  });

  it('injects GitHub theme styles', async () => {
    renderEditor();
    await waitForEditor();
    expect(document.querySelector('style')).toBeTruthy();
  });

  it('loads language support for python files', async () => {
    renderEditor({ value: 'print("hello")', filename: 'script.py' });
    await waitForEditor();
    expect(document.querySelector('.cm-content')?.textContent).toContain('print("hello")');
  });

  it('opens unknown extensions without error', async () => {
    renderEditor({ value: 'some content', filename: 'unknown.xyz' });
    await waitForEditor();
    expect(document.querySelector('.cm-content')?.textContent).toContain('some content');
  });

  it('updates content when value prop changes', async () => {
    const { rerender } = renderEditor({ value: 'initial' });
    await waitForEditor();
    expect(document.querySelector('.cm-content')?.textContent).toContain('initial');

    rerender(<CodeMirrorEditor value="updated" onChange={vi.fn()} readOnly={false} filename="test.js" />);
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toContain('updated');
    });
  });

  it('indents on Tab instead of letting the browser move focus', async () => {
    const onChange = vi.fn();
    renderEditor({ value: 'abc', onChange });
    await waitForEditor();
    const content = document.querySelector('.cm-content') as HTMLElement;

    const event = dispatchKey(content, { key: 'Tab', code: 'Tab' });

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    const next = onChange.mock.calls[0][0] as string;
    expect(next).toMatch(/^\s+abc$/);
  });

  it('shows line numbers in the gutter', async () => {
    renderEditor({ value: 'line one\nline two' });
    await waitForEditor();
    expect(document.querySelector('.cm-lineNumbers')).toBeTruthy();
  });

  it('selects all editor content on Ctrl+A when focused', async () => {
    renderEditor({ value: 'hello world' });
    await waitForEditor();
    const view = getEditorView();
    const content = document.querySelector('.cm-content') as HTMLElement;
    view.focus();

    const event = dispatchKey(content, {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
  });

  it('undoes edits on Ctrl+Z when editable', async () => {
    renderEditor({ value: 'hello' });
    await waitForEditor();
    const view = getEditorView();
    const content = document.querySelector('.cm-content') as HTMLElement;
    view.focus();

    view.dispatch({ changes: { from: 5, insert: ' world' } });
    expect(view.state.doc.toString()).toBe('hello world');

    const event = dispatchKey(content, {
      key: 'z',
      code: 'KeyZ',
      ctrlKey: true,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('hello');
  });

  it('does not mutate content on typing when readOnly', async () => {
    const onChange = vi.fn();
    renderEditor({ value: 'readonly', readOnly: true, onChange });
    await waitForEditor();
    const view = getEditorView();
    const content = document.querySelector('.cm-content') as HTMLElement;
    view.focus();

    dispatchKey(content, { key: 'x', code: 'KeyX' });

    expect(view.state.doc.toString()).toBe('readonly');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still selects all on Ctrl+A in readOnly mode', async () => {
    renderEditor({ value: 'readonly text', readOnly: true });
    await waitForEditor();
    const view = getEditorView();
    const content = document.querySelector('.cm-content') as HTMLElement;
    view.focus();

    const event = dispatchKey(content, {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
    });

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(view.state.doc.length);
  });
});

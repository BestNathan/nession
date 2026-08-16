import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { CodeMirrorEditor, type CodeMirrorEditorProps } from '../CodeMirrorEditor';
import { detectLanguage } from '../../lib/codeMirrorLanguages';

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

describe('detectLanguage', () => {
  it('detects JavaScript from .js extension', () => {
    expect(detectLanguage('app.js')).toBe('javascript');
  });

  it('detects JavaScript from .jsx extension', () => {
    expect(detectLanguage('component.jsx')).toBe('javascript');
  });

  it('detects TypeScript from .ts extension', () => {
    expect(detectLanguage('main.ts')).toBe('typescript');
  });

  it('detects TypeScript from .tsx extension', () => {
    expect(detectLanguage('component.tsx')).toBe('typescript');
  });

  it('detects Python from .py extension', () => {
    expect(detectLanguage('script.py')).toBe('python');
  });

  it('detects JSON from .json extension', () => {
    expect(detectLanguage('package.json')).toBe('json');
  });

  it('detects YAML from .yaml extension', () => {
    expect(detectLanguage('config.yaml')).toBe('yaml');
  });

  it('detects YAML from .yml extension', () => {
    expect(detectLanguage('config.yml')).toBe('yaml');
  });

  it('detects Markdown from .md extension', () => {
    expect(detectLanguage('README.md')).toBe('markdown');
  });

  it('detects HTML from .html extension', () => {
    expect(detectLanguage('index.html')).toBe('html');
  });

  it('detects CSS from .css extension', () => {
    expect(detectLanguage('styles.css')).toBe('css');
  });

  it('detects shell from .sh extension', () => {
    expect(detectLanguage('deploy.sh')).toBe('shell');
  });

  it('detects shell from .bash extension', () => {
    expect(detectLanguage('setup.bash')).toBe('shell');
  });

  it('returns "text" for unknown extensions', () => {
    expect(detectLanguage('file.xyz')).toBe('text');
  });

  it('returns "text" for files without extension', () => {
    expect(detectLanguage('Makefile')).toBe('text');
  });

  it('is case-insensitive on extensions', () => {
    expect(detectLanguage('APP.JS')).toBe('javascript');
    expect(detectLanguage('README.MD')).toBe('markdown');
  });

  it('handles nested paths', () => {
    expect(detectLanguage('src/components/App.tsx')).toBe('typescript');
    expect(detectLanguage('/home/user/.config.yaml')).toBe('yaml');
  });
});

describe('CodeMirrorEditor', () => {
  beforeEach(() => {
    // Ensure DOM is clean
  });

  afterEach(() => {
    // Cleanup
  });

  it('renders an editor with the initial value', () => {
    renderEditor({ value: 'console.log("hi")' });
    // CodeMirror renders content in a .cm-content element
    const content = document.querySelector('.cm-content');
    expect(content).toBeTruthy();
    expect(content?.textContent).toContain('console.log("hi")');
  });

  it('renders with empty value', () => {
    renderEditor({ value: '' });
    const content = document.querySelector('.cm-content');
    expect(content).toBeTruthy();
  });

  it('applies readonly mode', () => {
    renderEditor({ value: 'readonly text', readOnly: true });
    const content = document.querySelector('.cm-content');
    expect(content).toBeTruthy();
    expect(content?.getAttribute('contenteditable')).toBe('false');
  });

  it('renders editable by default', () => {
    renderEditor({ value: 'editable text', readOnly: false });
    const content = document.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('true');
  });

  it('has the CodeMirror editor container', () => {
    renderEditor();
    const editor = document.querySelector('.cm-editor');
    expect(editor).toBeTruthy();
  });

  it('applies a dark theme', () => {
    renderEditor();
    // The one-dark theme injects CSS styles via EditorView.theme.
    // In jsdom the style injection doesn't add a predictable class,
    // but the theme extension is included in the editor configuration.
    const editor = document.querySelector('.cm-editor');
    expect(editor).toBeTruthy();
    // Verify the theme's background color is applied via inline styles or class
    const styleEl = document.querySelector('style');
    expect(styleEl).toBeTruthy();
  });

  it('uses the filename prop for language detection', () => {
    // This is a smoke test - if Python language support loads without error
    // for a .py file, the component handles language switching correctly.
    renderEditor({ value: 'print("hello")', filename: 'script.py' });
    const content = document.querySelector('.cm-content');
    expect(content).toBeTruthy();
    expect(content?.textContent).toContain('print("hello")');
  });

  it('falls back to text for unknown file types', () => {
    renderEditor({ value: 'some content', filename: 'Dockerfile' });
    const content = document.querySelector('.cm-content');
    expect(content).toBeTruthy();
    expect(content?.textContent).toContain('some content');
  });

  it('updates content when value prop changes', () => {
    const { rerender } = renderEditor({ value: 'initial' });
    const content = document.querySelector('.cm-content');
    expect(content?.textContent).toContain('initial');

    rerender(<CodeMirrorEditor value="updated" onChange={vi.fn()} readOnly={false} filename="test.js" />);
    const updatedContent = document.querySelector('.cm-content');
    expect(updatedContent?.textContent).toContain('updated');
  });

  it('indents on Tab instead of letting the browser move focus', () => {
    // indentWithTab is NOT part of defaultKeymap. Without it CodeMirror leaves
    // Tab unhandled and the browser steals it for focus navigation, so typing
    // in the editor cannot indent at all.
    const onChange = vi.fn();
    renderEditor({ value: 'abc', onChange });
    const content = document.querySelector('.cm-content') as HTMLElement;
    expect(content).toBeTruthy();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      code: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    content.dispatchEvent(event);

    // The keybinding claimed the event (so the browser never sees it) and the
    // document gained leading indentation.
    expect(event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as string;
    expect(next).not.toBe('abc');
    expect(next).toMatch(/^\s+abc$/);
  });
});

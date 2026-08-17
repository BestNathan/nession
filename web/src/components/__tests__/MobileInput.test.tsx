import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileInput, type MobileInputHandle } from '../MobileInput';
import { createRef } from 'react';

describe('MobileInput', () => {
  const mockOnSend = vi.fn();
  const mockOnFocusChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render textarea', () => {
    render(<MobileInput onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox');
    expect(textarea).toBeInTheDocument();
  });

  it('should have correct attributes', () => {
    render(<MobileInput onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveAttribute('autocomplete', 'off');
    expect(textarea).toHaveAttribute('autocorrect', 'off');
    expect(textarea).toHaveAttribute('autocapitalize', 'off');
    expect(textarea).toHaveAttribute('spellcheck', 'false');
  });

  it('should call onSend when text is input', () => {
    render(<MobileInput onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.input(textarea, {
      target: { value: 'test' },
      inputType: 'insertText',
      data: 'test',
      isComposing: false,
    });

    expect(mockOnSend).toHaveBeenCalledWith('test');
  });

  it('should not call onSend during composition', () => {
    render(<MobileInput onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.input(textarea, {
      target: { value: 'test' },
      inputType: 'insertText',
      data: 'test',
      isComposing: true,
    });

    expect(mockOnSend).not.toHaveBeenCalled();
  });

  it('should clear textarea after input', () => {
    render(<MobileInput onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, {
      target: { value: 'test' },
      inputType: 'insertText',
      data: 'test',
      isComposing: false,
    });

    expect(textarea.value).toBe('');
  });

  it('should expose focus method via ref', () => {
    const ref = createRef<MobileInputHandle>();
    render(<MobileInput ref={ref} onSend={mockOnSend} />);

    expect(ref.current).toBeDefined();
    expect(ref.current?.focus).toBeDefined();
  });

  it('should expose sendText method via ref', () => {
    const ref = createRef<MobileInputHandle>();
    render(<MobileInput ref={ref} onSend={mockOnSend} />);

    ref.current?.sendText('test');
    expect(mockOnSend).toHaveBeenCalledWith('test');
  });

  it('should call onFocusChange when focused', () => {
    render(<MobileInput onSend={mockOnSend} onFocusChange={mockOnFocusChange} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.focus(textarea);
    expect(mockOnFocusChange).toHaveBeenCalledWith(true);
  });

  it('should call onFocusChange when blurred', () => {
    render(<MobileInput onSend={mockOnSend} onFocusChange={mockOnFocusChange} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.blur(textarea);
    expect(mockOnFocusChange).toHaveBeenCalledWith(false);
  });

  it('should not throw on focus/blur when onFocusChange is omitted', () => {
    render(<MobileInput onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox');

    expect(() => {
      fireEvent.focus(textarea);
      fireEvent.blur(textarea);
    }).not.toThrow();
  });

  it('should focus the textarea via the ref handle', () => {
    const ref = createRef<MobileInputHandle>();
    render(<MobileInput ref={ref} onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox');

    ref.current?.focus();
    expect(textarea).toHaveFocus();
  });

  it('should ignore input events that are not insertText', () => {
    render(<MobileInput onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.input(textarea, {
      inputType: 'deleteContentBackward',
      data: null,
      isComposing: false,
    });

    expect(mockOnSend).not.toHaveBeenCalled();
  });

  describe('key mapping', () => {
    it.each([
      ['Enter', '\r'],
      ['Backspace', '\x7f'],
      ['Escape', '\x1b'],
      ['Tab', '\t'],
      ['ArrowUp', '\x1b[A'],
      ['ArrowDown', '\x1b[B'],
      ['ArrowLeft', '\x1b[D'],
      ['ArrowRight', '\x1b[C'],
    ])('should send %s as %j', (key, expected) => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      fireEvent.keyDown(textarea, { key });
      expect(mockOnSend).toHaveBeenCalledWith(expected);
    });

    it('should clear the textarea on Enter', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      textarea.value = 'pending';

      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(textarea.value).toBe('');
    });

    it('should keep the textarea value for non-Enter mapped keys', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      textarea.value = 'pending';

      fireEvent.keyDown(textarea, { key: 'ArrowUp' });
      expect(textarea.value).toBe('pending');
    });

    it('should ignore unmapped keys and not preventDefault', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      const notPrevented = fireEvent.keyDown(textarea, { key: 'a' });
      expect(mockOnSend).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
    });

    it('should preventDefault for mapped keys', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      const notPrevented = fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(notPrevented).toBe(false);
    });
  });

  describe('IME composition guards', () => {
    it('should ignore keydown while a composition is active', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(mockOnSend).not.toHaveBeenCalled();
    });

    it('should resume handling keydown after the composition ends', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      fireEvent.compositionStart(textarea);
      fireEvent.compositionEnd(textarea);
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(mockOnSend).toHaveBeenCalledWith('\r');
    });

    it('should ignore keydown when the event itself is composing', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
      expect(mockOnSend).not.toHaveBeenCalled();
    });

    it('should ignore keydown for the IME placeholder keyCode 229', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
      expect(mockOnSend).not.toHaveBeenCalled();
    });

    it('should clear the textarea asynchronously after compositionend', () => {
      vi.useFakeTimers();
      try {
        render(<MobileInput onSend={mockOnSend} />);
        const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
        textarea.value = '中文';

        fireEvent.compositionEnd(textarea);
        expect(textarea.value).toBe('中文');

        vi.runAllTimers();
        expect(textarea.value).toBe('');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('paste', () => {
    it('should send pasted text and preventDefault', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      const notPrevented = fireEvent.paste(textarea, {
        clipboardData: { getData: () => 'pasted' },
      });

      expect(mockOnSend).toHaveBeenCalledWith('pasted');
      expect(notPrevented).toBe(false);
    });

    it('should ignore a paste with no text payload', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      fireEvent.paste(textarea, { clipboardData: { getData: () => '' } });
      expect(mockOnSend).not.toHaveBeenCalled();
    });

    it('should ignore a paste with no clipboardData', () => {
      render(<MobileInput onSend={mockOnSend} />);
      const textarea = screen.getByRole('textbox');

      fireEvent.paste(textarea, { clipboardData: null });
      expect(mockOnSend).not.toHaveBeenCalled();
    });
  });

  it('should detach listeners on unmount', () => {
    const { unmount } = render(<MobileInput onSend={mockOnSend} />);
    const textarea = screen.getByRole('textbox');

    unmount();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.paste(textarea, { clipboardData: { getData: () => 'x' } });

    expect(mockOnSend).not.toHaveBeenCalled();
  });
});

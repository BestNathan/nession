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
});

import { forwardRef, useRef, useEffect, useImperativeHandle } from 'react';

export interface MobileInputHandle {
  focus: () => void;
  sendText: (text: string) => void;
}

interface MobileInputProps {
  onSend: (text: string) => void;
  onFocusChange?: (focused: boolean) => void;
}

// Event handlers extracted to reduce component line count
function createInputHandler(
  textarea: HTMLTextAreaElement,
  onSend: (text: string) => void,
) {
  return (ev: Event) => {
    const ie = ev as InputEvent;
    if (ie.inputType === 'insertText' && ie.data && !ie.isComposing) {
      onSend(ie.data);
      textarea.value = '';
    }
  };
}

function createKeyDownHandler(
  textarea: HTMLTextAreaElement,
  onSend: (text: string) => void,
  isComposingRef: React.MutableRefObject<boolean>,
) {
  return (ev: KeyboardEvent) => {
    if (isComposingRef.current || ev.isComposing || ev.keyCode === 229) {
      return;
    }

    const keyMap: Record<string, string> = {
      Enter: '\r',
      Backspace: '\x7f',
      Escape: '\x1b',
      Tab: '\t',
      ArrowUp: '\x1b[A',
      ArrowDown: '\x1b[B',
      ArrowLeft: '\x1b[D',
      ArrowRight: '\x1b[C',
    };

    const data = keyMap[ev.key];
    if (data) {
      ev.preventDefault();
      onSend(data);
      if (ev.key === 'Enter') {
        textarea.value = '';
      }
    }
  };
}

/**
 * MobileInput — a visible textarea that replaces xterm's hidden one on
 * touch devices. The textarea is positioned at xterm's cursor position
 * (like xterm's _syncTextArea does on desktop), giving the browser and
 * IME a valid, in-viewport editable element to anchor to.
 *
 * All keyboard, IME composition, and paste events flow through this
 * textarea natively. Committed text goes directly to the PTY via
 * onSend. xterm handles rendering only.
 */
export const MobileInput = forwardRef<MobileInputHandle, MobileInputProps>(
  function MobileInput({ onSend, onFocusChange }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const isComposingRef = useRef(false);

    useImperativeHandle(ref, () => ({
      focus: () => {
        textareaRef.current?.focus();
      },
      sendText: (text: string) => {
        onSend(text);
      },
    }));

    useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      const handleInput = createInputHandler(textarea, onSend);
      const handleKeyDown = createKeyDownHandler(textarea, onSend, isComposingRef);

      const handleCompositionStart = () => {
        isComposingRef.current = true;
      };

      const handleCompositionEnd = () => {
        isComposingRef.current = false;
        setTimeout(() => {
          textarea.value = '';
        }, 0);
      };

      const handlePaste = (ev: ClipboardEvent) => {
        const text = ev.clipboardData?.getData('text/plain');
        if (text) {
          ev.preventDefault();
          onSend(text);
        }
      };

      const handleFocus = () => {
        onFocusChange?.(true);
      };

      const handleBlur = () => {
        onFocusChange?.(false);
      };

      textarea.addEventListener('input', handleInput);
      textarea.addEventListener('keydown', handleKeyDown);
      textarea.addEventListener('compositionstart', handleCompositionStart);
      textarea.addEventListener('compositionend', handleCompositionEnd);
      textarea.addEventListener('paste', handlePaste);
      textarea.addEventListener('focus', handleFocus);
      textarea.addEventListener('blur', handleBlur);

      return () => {
        textarea.removeEventListener('input', handleInput);
        textarea.removeEventListener('keydown', handleKeyDown);
        textarea.removeEventListener('compositionstart', handleCompositionStart);
        textarea.removeEventListener('compositionend', handleCompositionEnd);
        textarea.removeEventListener('paste', handlePaste);
        textarea.removeEventListener('focus', handleFocus);
        textarea.removeEventListener('blur', handleBlur);
      };
    }, [onSend, onFocusChange]);

    return (
      <textarea
        ref={textareaRef}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="mobile-input-textarea"
        style={{
          position: 'absolute',
          zIndex: 10,
          opacity: 0.01,
          background: 'transparent',
          color: 'transparent',
          caretColor: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          fontFamily: 'monospace',
          fontSize: '16px',
          lineHeight: 1,
          resize: 'none',
          overflow: 'hidden',
          outline: 'none',
          width: '1px',
          height: '1px',
          left: 0,
          top: 0,
        }}
      />
    );
  }
);

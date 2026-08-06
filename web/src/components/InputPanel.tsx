import { useState, useRef } from 'react';
import { X, Copy, ClipboardPaste, SendHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useCommandHistory, type HistoryEntry } from '../hooks/useCommandHistory';

interface InputPanelProps {
  sendText: (text: string) => void;
  disabled: boolean;
}

interface ActionButtonsProps {
  inputValue: string;
  disabled: boolean;
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSend: () => void;
}

interface HistorySectionProps {
  entries: HistoryEntry[];
  inputValue: string;
  onSelect: (command: string) => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ActionButtons({
  inputValue,
  disabled,
  onClear,
  onCopy,
  onPaste,
  onSend,
}: ActionButtonsProps) {
  return (
    <div className="flex items-center gap-1 px-2 pt-1.5 pb-0.5 flex-shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled || !inputValue}
        onClick={onClear}
        aria-label="Clear input"
        title="Clear"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled || !inputValue}
        onClick={onCopy}
        aria-label="Copy input"
        title="Copy"
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled}
        onClick={onPaste}
        aria-label="Paste to input"
        title="Paste"
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
      </Button>
      <div className="flex-1" />
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1"
        disabled={disabled || !inputValue.trim()}
        onClick={onSend}
        aria-label="Send"
      >
        <SendHorizontal className="h-3.5 w-3.5" /> Send
      </Button>
    </div>
  );
}

function HistorySection({ entries, inputValue, onSelect }: HistorySectionProps) {
  if (entries.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground px-1">
        {inputValue ? 'No matching commands' : 'No command history yet'}
      </p>
    );
  }
  return (
    <div className="space-y-0.5">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onSelect(entry.command)}
          className="w-full text-left text-xs px-2 py-1 rounded hover:bg-accent/50 flex items-center justify-between gap-2"
        >
          <span className="truncate font-mono">{entry.command}</span>
          <span className="text-[10px] text-muted-foreground flex-shrink-0">
            {relativeTime(entry.timestamp)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function InputPanel({ sendText, disabled }: InputPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { filterHistory, addEntry, clearHistory } = useCommandHistory();

  const doSend = () => {
    const text = inputValue.trim();
    if (!text) {
      return;
    }
    sendText(text + '\r');
    addEntry(text);
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSend();
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inputValue);
    } catch {
      // clipboard unavailable
    }
  };

  const handlePasteButton = () => {
    const ta = textareaRef.current;
    if (!ta) { return; }
    ta.focus();
    // execCommand('paste') works on HTTP with a user gesture (button click).
    // The textarea's onPaste handler reads e.clipboardData and appends the
    // pasted text, so no need to parse the result here.
    try { document.execCommand('paste'); } catch { /* unsupported */ }
  };

  // Handle native paste events on the textarea (Cmd+V / long-press→Paste).
  const handleTextareaPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData?.getData('text');
    if (text) {
      e.preventDefault();
      setInputValue((prev) => prev + text);
    }
  };

  const matchingHistory = filterHistory(inputValue);

  return (
    <div className="flex flex-col min-h-0 h-full">
      <ActionButtons
        inputValue={inputValue}
        disabled={disabled}
        onClear={() => setInputValue('')}
        onCopy={handleCopy}
        onPaste={handlePasteButton}
        onSend={doSend}
      />

      {/* Textarea — fixed height, 2-3 rows */}
      <div className="px-2 pb-1 flex-shrink-0">
        <Textarea
          ref={textareaRef}
          placeholder="Type to send… (Enter to submit, Shift+Enter for newline)"
          value={inputValue}
          rows={3}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handleTextareaPaste}
          className="text-xs resize-none h-[3.25rem] field-sizing-fixed py-1.5"
          disabled={disabled}
        />
      </div>

      {/* History */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {inputValue ? (
          <div className="text-[11px] text-muted-foreground mb-1 px-1">
            Matching ({matchingHistory.length})
          </div>
        ) : (
          <div className="flex items-center justify-between mb-1 px-1">
            <span className="text-[11px] text-muted-foreground">
              History ({matchingHistory.length})
            </span>
            {matchingHistory.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        )}
        <HistorySection
          entries={matchingHistory}
          inputValue={inputValue}
          onSelect={(command) => setInputValue(command)}
        />
      </div>
    </div>
  );
}

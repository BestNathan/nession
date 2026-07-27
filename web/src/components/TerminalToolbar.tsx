import { useState } from 'react';
import { Minus, Plus as PlusIcon, RotateCcw, SendHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useQuickCommands } from '../hooks/useQuickCommands';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

export interface TerminalToolbarProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  fontSizeManager?: FontSizeManager | null;
}

interface ZoomControlsProps {
  fontSizeManager: FontSizeManager;
  disabled: boolean;
}

function ZoomControls({ fontSizeManager, disabled }: ZoomControlsProps) {
  const [size, setSize] = useState(() => fontSizeManager.getSize());

  const handleZoomIn = () => {
    fontSizeManager.zoomIn();
    setSize(fontSizeManager.getSize());
  };

  const handleZoomOut = () => {
    fontSizeManager.zoomOut();
    setSize(fontSizeManager.getSize());
  };

  const handleZoomReset = () => {
    fontSizeManager.reset();
    setSize(fontSizeManager.getSize());
  };

  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={handleZoomOut}
        disabled={disabled}
        title="Zoom out"
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <span className="text-xs font-mono min-w-[3rem] text-center">
        {size}px
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={handleZoomIn}
        disabled={disabled}
        title="Zoom in"
      >
        <PlusIcon className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={handleZoomReset}
        disabled={disabled}
        title="Reset zoom"
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function TerminalToolbar({ sendText, disabled = false, fontSizeManager }: TerminalToolbarProps) {
  const { userCommands, addCommand, deleteCommand } = useQuickCommands();
  const [inputValue, setInputValue] = useState('');

  const sendInput = () => {
    const text = inputValue.trim();
    if (!text) {
      return;
    }
    sendText(text + '\r');
    setInputValue('');
  };

  return (
    <div className="flex flex-col min-h-0">
      <QuickCommandsPanel
        userCommands={userCommands}
        disabled={disabled}
        onRunCommand={(cmd) => sendText(cmd.raw ? cmd.command : cmd.command + '\r')}
        onDeleteCommand={deleteCommand}
        onAddCommand={addCommand}
      />

      {/* Input row — pinned to bottom; multi-line, fixed ~3 rows */}
      <div className="flex gap-1.5 flex-shrink-0 p-2 pt-1 border-t items-end">
        <Textarea
          placeholder="Type to send… (Enter to submit, Shift+Enter for newline)"
          value={inputValue}
          rows={3}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              sendInput();
            }
          }}
          className="text-xs md:text-xs flex-1 min-h-0 h-[4.5rem] resize-none field-sizing-fixed py-1.5"
          disabled={disabled}
        />
        <div className="flex flex-col gap-1.5">
          <Button variant="outline" size="icon" className="h-11 w-11 md:h-7 md:w-7 flex-shrink-0" aria-label="Send" title="Send"
            onClick={sendInput} disabled={disabled}>
            <SendHorizontal className="h-3.5 w-3.5" />
          </Button>
          {fontSizeManager && (
            <ZoomControls fontSizeManager={fontSizeManager} disabled={disabled} />
          )}
        </div>
      </div>
    </div>
  );
}
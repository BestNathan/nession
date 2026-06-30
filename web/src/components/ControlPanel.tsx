import { useState } from 'react';
import {
  PRESETS,
  loadUserCommands,
  saveUserCommands,
  type QuickCommand,
} from './quickCommands';
import './ControlPanel.css';

export interface ControlPanelProps {
  /** Send text to the attached terminal session. */
  sendText: (text: string) => void;
}

/**
 * Sidebar with one-click quick commands (presets + user-added) and a free-text
 * input box. Quick commands auto-execute (append "\r") unless flagged `raw`.
 * The free-text box appends "\r" on send so the command runs.
 */
export function ControlPanel({ sendText }: ControlPanelProps) {
  const [userCommands, setUserCommands] = useState<QuickCommand[]>(() => loadUserCommands());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [inputValue, setInputValue] = useState('');

  const runCommand = (cmd: QuickCommand) => {
    sendText(cmd.raw ? cmd.command : cmd.command + '\r');
  };

  const deleteUserCommand = (id: string) => {
    const next = userCommands.filter((c) => c.id !== id);
    setUserCommands(next);
    saveUserCommands(next);
  };

  const addUserCommand = () => {
    const label = newLabel.trim();
    const command = newCommand.trim();
    if (!label || !command) return;
    // Suffix a random segment so two commands added in the same millisecond
    // still get distinct ids — deleteUserCommand filters by id.
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next = [...userCommands, { id, label, command }];
    setUserCommands(next);
    saveUserCommands(next);
    setNewLabel('');
    setNewCommand('');
    setShowAddForm(false);
  };

  const cancelAddForm = () => {
    // Discard any in-progress draft so the form opens clean next time.
    setNewLabel('');
    setNewCommand('');
    setShowAddForm(false);
  };

  const sendInput = () => {
    const text = inputValue.trim();
    if (!text) return;
    sendText(text + '\r');
    setInputValue('');
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
    }
  };

  return (
    <aside className="control-panel">
      <h3 className="control-panel-section-title">Quick Commands</h3>
      <div className="control-panel-commands">
        {PRESETS.map((cmd) => (
          <div className="control-panel-command-row" key={cmd.id}>
            <button className="control-panel-command-btn" onClick={() => runCommand(cmd)}>
              {cmd.label}
            </button>
          </div>
        ))}
        {userCommands.map((cmd) => (
          <div className="control-panel-command-row" key={cmd.id}>
            <button className="control-panel-command-btn" onClick={() => runCommand(cmd)}>
              {cmd.label}
            </button>
            <button
              className="control-panel-delete-btn"
              onClick={() => deleteUserCommand(cmd.id)}
              title="Delete command"
            >
              &times;
            </button>
          </div>
        ))}

        {showAddForm ? (
          <div className="control-panel-add-form">
            <input
              type="text"
              placeholder="Label"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <input
              type="text"
              placeholder="Command"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
            />
            <div className="control-panel-add-form-actions">
              <button onClick={cancelAddForm}>Cancel</button>
              <button className="primary" onClick={addUserCommand}>
                Add
              </button>
            </div>
          </div>
        ) : (
          <button className="control-panel-add-btn" onClick={() => setShowAddForm(true)}>
            + Add command
          </button>
        )}
      </div>

      <div className="control-panel-input-area">
        <textarea
          rows={2}
          placeholder="Type text to send… (Enter to send, Shift+Enter for newline)"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <button className="control-panel-send-btn" onClick={sendInput}>
          Send
        </button>
      </div>
    </aside>
  );
}

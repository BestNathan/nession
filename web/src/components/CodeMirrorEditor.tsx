import { useEffect, useState } from 'react';
import type { Extension } from '@codemirror/state';
import CodeMirror from '@uiw/react-codemirror';
import { useScheduledGithubTheme } from '../hooks/useScheduledGithubTheme';
import {
  ensureLangsModule,
  loadLangExtensionForFile,
} from '../lib/codeMirrorLangs';

export interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  language?: string;
  filename?: string;
}

export function CodeMirrorEditor({
  value,
  onChange,
  readOnly = false,
  language,
  filename,
}: CodeMirrorEditorProps) {
  const theme = useScheduledGithubTheme();
  const [langExtensions, setLangExtensions] = useState<Extension[]>([]);
  const path = filename ?? '';

  useEffect(() => {
    let cancelled = false;
    void ensureLangsModule();
    void loadLangExtensionForFile(path, language).then((ext) => {
      if (!cancelled) {
        setLangExtensions(ext ? [ext] : []);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path, language]);

  return (
    <div
      className="w-full h-full overflow-auto [&_.cm-editor]:h-full [&_.cm-scroller]:!overflow-auto"
      data-testid="codemirror-editor"
    >
      <CodeMirror
        value={value}
        height="100%"
        theme={theme}
        readOnly={readOnly}
        editable={!readOnly}
        basicSetup={{ tabSize: 2 }}
        indentWithTab
        extensions={langExtensions}
        onChange={(next) => onChange(next)}
        className="h-full"
      />
    </div>
  );
}

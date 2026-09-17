import { useEffect, useState } from 'react';
import type { Extension } from '@codemirror/state';
import CodeMirror from '@uiw/react-codemirror';
import { EDITOR_METRICS, EDITOR_THEME } from '../model/editorTheme';
import {
  ensureLangsModule,
  loadLangExtensionForFile,
} from '../model/codeMirrorLangs';

export interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  language?: string;
  filename?: string;
}

/**
 * The code surface.
 *
 * Metrics are applied as Tailwind arbitrary variants on the wrapper rather than
 * as a CodeMirror `EditorView.theme`. Writing that theme means importing
 * `@codemirror/view`, which is present only as a transitive dependency of
 * `@uiw/react-codemirror` — an undeclared import that works until the hoisting
 * changes. The wrapper already styles `.cm-*` this way for `h-full`, and these
 * selectors carry higher specificity than the theme's own, so the values land.
 */
export function CodeMirrorEditor({
  value,
  onChange,
  readOnly = false,
  language,
  filename,
}: CodeMirrorEditorProps) {
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
      className="h-full w-full overflow-auto [&_.cm-editor]:h-full [&_.cm-scroller]:!overflow-auto"
      data-testid="codemirror-editor"
    >
      <CodeMirror
        value={value}
        height="100%"
        theme={[EDITOR_THEME, EDITOR_METRICS]}
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

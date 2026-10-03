import { useEffect, useRef, useState } from 'react';
import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { cn } from '@/shared/lib/utils';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
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
  /** 1-based line to scroll to after content loads (#1175). */
  initialLine?: number;
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
  initialLine,
}: CodeMirrorEditorProps) {
  const [langExtensions, setLangExtensions] = useState<Extension[]>([]);
  const path = filename ?? '';
  const viewRef = useRef<EditorView | null>(null);
  const scrolledToLine = useRef<number | null>(null);

  const scrollToInitialLine = (view: EditorView, lineNumber: number) => {
    if (view.state.doc.length === 0) {
      return;
    }
    const line = Math.min(Math.max(1, lineNumber), view.state.doc.lines);
    const lineObj = view.state.doc.line(line);
    view.dispatch({
      selection: EditorSelection.cursor(lineObj.from),
      effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
    });
    scrolledToLine.current = lineNumber;
  };

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

  useEffect(() => {
    if (!initialLine || !value || !viewRef.current) {
      return;
    }
    if (scrolledToLine.current === initialLine) {
      return;
    }
    scrollToInitialLine(viewRef.current, initialLine);
  }, [initialLine, value]);

  return (
    <div
      // The editor is a Workspace scroller wherever the Workspace hosts it, so
      // it spends the capsule clearance like every other one. The padding goes
      // on this host rather than on `.cm-scroller`: the editor fills the host's
      // content box, so the scroller's reachable end stops above the padded
      // edge — and CodeMirror keeps its own metrics untouched (the renderer
      // boundary measures the scroller's own font and line height).
      className={cn(
        'h-full w-full overflow-auto [&_.cm-editor]:h-full [&_.cm-scroller]:!overflow-auto',
        workspaceScrollClearanceClass,
      )}
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
        onCreateEditor={(view) => {
          viewRef.current = view;
          if (initialLine && value) {
            scrollToInitialLine(view, initialLine);
          }
        }}
        className="h-full"
      />
    </div>
  );
}

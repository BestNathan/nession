import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** 1-based column within `initialLine` when the reference carried one (#3187). */
  initialColumn?: number;
}

/**
 * The editor's visible source position, as an observable contract.
 *
 * `data-selection-line` / `data-selection-column` are 1-based and track the
 * cursor's real EditorState selection. E2E and Acceptance Cases need to assert
 * the visible line/column the user was taken to, and CodeMirror keeps that
 * state behind its own module instance — a host attribute is the only stable
 * read that does not reimplement the editor.
 */
function publishSelection(view: EditorView): void {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  view.dom.setAttribute('data-selection-line', String(line.number));
  view.dom.setAttribute('data-selection-column', String(head - line.from + 1));
}

const SELECTION_REPORTER = EditorView.updateListener.of((update) => {
  if (update.selectionSet || update.docChanged) {
    publishSelection(update.view);
  }
});

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
  initialColumn,
}: CodeMirrorEditorProps) {
  const [langExtensions, setLangExtensions] = useState<Extension[]>([]);
  const path = filename ?? '';
  const viewRef = useRef<EditorView | null>(null);
  const appliedPosition = useRef<string | null>(null);
  const positionKey = initialLine === undefined
    ? null
    : `${initialLine}:${initialColumn ?? ''}`;
  const extensions = useMemo(
    () => [...langExtensions, SELECTION_REPORTER],
    [langExtensions],
  );

  const scrollToInitialPosition = (
    view: EditorView,
    lineNumber: number,
    column: number | undefined,
    key: string,
  ) => {
    if (view.state.doc.length === 0) {
      return;
    }
    const line = Math.min(Math.max(1, lineNumber), view.state.doc.lines);
    const lineObj = view.state.doc.line(line);
    // The reference is 1-based; an out-of-range column clamps to the line's
    // end rather than refusing the navigation.
    const offset = column === undefined
      ? 0
      : Math.min(Math.max(0, column - 1), lineObj.length);
    const position = lineObj.from + offset;
    view.dispatch({
      selection: EditorSelection.cursor(position),
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
    });
    publishSelection(view);
    appliedPosition.current = key;
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
    if (positionKey === null || !value || !viewRef.current) {
      return;
    }
    if (appliedPosition.current === positionKey) {
      return;
    }
    scrollToInitialPosition(viewRef.current, initialLine!, initialColumn, positionKey);
  }, [positionKey, initialLine, initialColumn, value]);

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
        extensions={extensions}
        onChange={(next) => onChange(next)}
        onCreateEditor={(view) => {
          viewRef.current = view;
          publishSelection(view);
          if (initialLine !== undefined && value) {
            scrollToInitialPosition(
              view,
              initialLine,
              initialColumn,
              positionKey ?? `${initialLine}:${initialColumn ?? ''}`,
            );
          }
        }}
        className="h-full"
      />
    </div>
  );
}

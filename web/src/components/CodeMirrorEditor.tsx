import { useEffect, useRef, useCallback } from 'react';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { detectLanguage, getLanguage } from '../lib/codeMirrorLanguages';

export interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  language?: string;
  filename?: string;
}

function getLanguageExtensions(language: string): Extension[] {
  if (language === 'text') {
    return [];
  }
  const loaded = getLanguage(language);
  return loaded ?? [];
}

export function CodeMirrorEditor({
  value,
  onChange,
  readOnly = false,
  language,
  filename,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());

  // Keep onChange ref current without recreating the editor
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Detect language from filename if language prop is not provided
  const resolvedLanguage = language || (filename ? detectLanguage(filename) : 'text');

  // Build the initial extensions list
  const buildExtensions = useCallback(
    (isReadOnly: boolean, lang: string): Extension[] => [
      keymap.of(defaultKeymap),
      oneDark,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newValue = update.state.doc.toString();
          onChangeRef.current(newValue);
        }
      }),
      readOnlyCompartment.current.of(EditorState.readOnly.of(isReadOnly)),
      editableCompartment.current.of(EditorView.editable.of(!isReadOnly)),
      ...getLanguageExtensions(lang),
    ],
    [],
  );

  // Create editor on mount (only once)
  // Store initial values in refs to avoid dependency issues
  const initialValueRef = useRef(value);
  const initialReadOnlyRef = useRef(readOnly);
  const initialLanguageRef = useRef(resolvedLanguage);

  useEffect(() => {
    if (!containerRef.current) {return;}

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: buildExtensions(initialReadOnlyRef.current, initialLanguageRef.current),
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [buildExtensions]);

  // Update value when prop changes (external updates)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {return;}
    const currentValue = view.state.doc.toString();
    if (value !== currentValue) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [value]);

  // Update readOnly when prop changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {return;}
    view.dispatch({
      effects: [
        readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
        editableCompartment.current.reconfigure(EditorView.editable.of(!readOnly)),
      ],
    });
  }, [readOnly]);

  // Update language when it changes (requires full recreate since language
  // extensions can't simply be swapped via compartment in all cases)
  const prevLanguageRef = useRef(resolvedLanguage);
  useEffect(() => {
    if (prevLanguageRef.current === resolvedLanguage) {return;}
    prevLanguageRef.current = resolvedLanguage;

    const view = viewRef.current;
    if (!view) {return;}

    const currentValue = view.state.doc.toString();
    view.destroy();

    if (!containerRef.current) {return;}

    const state = EditorState.create({
      doc: currentValue,
      extensions: buildExtensions(readOnly, resolvedLanguage),
    });

    const newView = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = newView;
  }, [resolvedLanguage, readOnly, buildExtensions]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-auto [&_.cm-editor]:h-full [&_.cm-scroller]:!overflow-auto"
      data-testid="codemirror-editor"
    />
  );
}

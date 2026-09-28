export { CodeMirrorEditor } from './components/CodeMirrorEditor';
export type { CodeMirrorEditorProps } from './components/CodeMirrorEditor';
export { EDITOR_METRICS, EDITOR_THEME } from './model/editorTheme';
export {
  ensureLangsModule,
  loadLangExtensionForFile,
  loadLangExtensionForLanguageId,
  registerSeenLanguageIds,
  scanLanguageIdsFromPaths,
} from './model/codeMirrorLangs';
export { languageIdToCodeMirrorKey } from './model/languageIdToCodeMirror';

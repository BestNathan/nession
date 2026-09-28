import { EnvPlugin } from './EnvPlugin';
export { EnvPlugin } from './EnvPlugin';
export type {
  ActiveEnvFile,
  EnvDeleteResponse,
  EnvFileInfo,
  EnvFileRef,
  EnvGetResponse,
  EnvListResponse,
  EnvSource,
  EnvWriteResponse,
  SessionEnvActiveResponse,
  SessionEnvQueryResponse,
  SessionEnvResponse,
} from './types';

/** App-level singleton — one env binding per WebSocketService lifetime. */
export const envApi = new EnvPlugin();

// The presentation half of the capability, for the surfaces that compose it —
// the Attach/Create dialogs offer env files, the Workspace views render the
// context-first Environment surfaces (#1202). Exported here rather than
// reached by deep path so the capability stays free to move its own files
// (#801 acceptance criterion: capability cross-import goes through an
// explicit public API, not an arbitrary deep import). See
// `capabilities/files/index.ts` for the same note.
export { EnvFileMultiSelect } from './components/EnvFileMultiSelect';
export { EnvironmentNavigator } from './components/EnvironmentNavigator';
export { EnvProfileDetail } from './components/EnvProfileDetail';
export { EnvProfileEditor, type EnvProfileSaveInput } from './components/EnvProfileEditor';
export { EnvImportDialog } from './components/EnvImportDialog';
export { EnvironmentGuardDialog } from './components/EnvironmentGuardDialog';
export {
  useEnvironmentWorkspace,
  type EnvironmentWorkspace,
} from './hooks/useEnvironmentWorkspace';
export { editorTargetKey, type EditorTarget } from './hooks/useEnvironmentScreen';
export { refKey } from './model/envRef';

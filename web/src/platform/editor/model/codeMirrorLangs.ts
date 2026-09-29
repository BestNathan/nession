import type { Extension } from '@codemirror/state';
import { LanguageSupport, StreamLanguage } from '@codemirror/language';
import type { LanguageName } from '@uiw/codemirror-extensions-langs';
import { detectLanguage, type LanguageId } from '@/shared/lib/languageId';
import { languageIdToCodeMirrorKey } from './languageIdToCodeMirror';

type LangsModule = typeof import('@uiw/codemirror-extensions-langs');

let langsModule: LangsModule | null = null;
let langsPromise: Promise<LangsModule> | null = null;
const sessionSeenLangKeys = new Set<string>();

async function loadDockerfileExtension(): Promise<Extension> {
  const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
  return new LanguageSupport(StreamLanguage.define(dockerFile));
}

/** Collect unique LanguageIds present in a directory listing. */
export function scanLanguageIdsFromPaths(paths: string[]): LanguageId[] {
  const seen = new Set<LanguageId>();
  for (const path of paths) {
    const id = detectLanguage(path);
    if (id !== 'plaintext') {
      seen.add(id);
    }
  }
  return [...seen];
}

/** Load syntax highlighting extension for a LanguageId. */
export async function loadLangExtensionForLanguageId(
  languageId: LanguageId,
): Promise<Extension | null> {
  const key = languageIdToCodeMirrorKey(languageId);
  if (!key) {
    return null;
  }
  return extensionForLangKey(key);
}

/** Register LanguageIds seen in a listing; prefetches the langs module when non-empty. */
export function registerSeenLanguageIds(ids: Iterable<LanguageId>): void {
  for (const id of ids) {
    const key = languageIdToCodeMirrorKey(id);
    if (key) {
      sessionSeenLangKeys.add(key);
    }
  }
  if (sessionSeenLangKeys.size > 0) {
    void ensureLangsModule();
  }
}

/** Dynamic import of @uiw/codemirror-extensions-langs (once per session). */
export function ensureLangsModule(): Promise<LangsModule> {
  if (langsModule) {
    return Promise.resolve(langsModule);
  }
  langsPromise ??= import('@uiw/codemirror-extensions-langs').then((mod) => {
    langsModule = mod;
    return mod;
  });
  return langsPromise;
}

export function getSessionSeenLangKeys(): ReadonlySet<string> {
  return sessionSeenLangKeys;
}

/** Reset module state — test helper only. */
export function resetLangsModuleForTests(): void {
  langsModule = null;
  langsPromise = null;
  sessionSeenLangKeys.clear();
}

async function extensionForLangKey(key: string): Promise<Extension | null> {
  if (key === '__dockerfile__') {
    return loadDockerfileExtension();
  }

  const { loadLanguage } = await ensureLangsModule();
  const loaded = loadLanguage(key as LanguageName);
  return loaded ?? null;
}

/** Load syntax highlighting extension for a file path (or plain null). */
export async function loadLangExtensionForFile(
  path: string,
  language?: string,
): Promise<Extension | null> {
  // Explicit override
  if (language) {
    const languageId = language as LanguageId;
    return loadLangExtensionForLanguageId(languageId);
  }

  const languageId = detectLanguage(path);
  return loadLangExtensionForLanguageId(languageId);
}

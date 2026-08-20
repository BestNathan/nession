import type { Extension } from '@codemirror/state';
import { LanguageSupport, StreamLanguage } from '@codemirror/language';
import type { LanguageName } from '@uiw/codemirror-extensions-langs';
import { getLangKey, parseBasename, parseExt } from './viewerRegistry';

type LangsModule = typeof import('@uiw/codemirror-extensions-langs');

/** Map extension / legacy names to @uiw/codemirror-extensions-langs keys. */
const LANG_KEY_ALIASES: Record<string, string> = {
  env: 'properties',
  zsh: 'sh',
  kotlin: 'kt',
  javascript: 'js',
  typescript: 'ts',
  shell: 'sh',
  ruby: 'rb',
  rust: 'rs',
  python: 'py',
  markdown: 'md',
  dockerfile: '__dockerfile__',
  makefile: 'sh',
};

const BASENAME_LANG_KEYS: Record<string, string> = {
  Dockerfile: '__dockerfile__',
  Makefile: 'sh',
  GNUmakefile: 'sh',
  Jenkinsfile: 'groovy',
  Gemfile: 'rb',
  Rakefile: 'rb',
  'CMakeLists.txt': 'cmake',
};

let langsModule: LangsModule | null = null;
let langsPromise: Promise<LangsModule> | null = null;
const sessionSeenLangKeys = new Set<string>();

async function loadDockerfileExtension(): Promise<Extension> {
  const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
  return new LanguageSupport(StreamLanguage.define(dockerFile));
}

function normalizeLangKey(key: string): string {
  return LANG_KEY_ALIASES[key] ?? key;
}

/** Resolve a UIW langs key from a file path or explicit language prop. */
export function resolveLangKey(path: string, language?: string): string | null {
  if (language) {
    const fromProp = normalizeLangKey(language.toLowerCase());
    if (fromProp !== '__dockerfile__') {
      return fromProp;
    }
    return '__dockerfile__';
  }

  const basename = parseBasename(path);
  const fromBasename = BASENAME_LANG_KEYS[basename];
  if (fromBasename) {
    return fromBasename;
  }

  const ext = parseExt(path);
  if (!ext) {
    return null;
  }

  const mapped = getLangKey(ext);
  if (!mapped) {
    return null;
  }

  return normalizeLangKey(mapped);
}

/** Collect unique UIW lang keys present in a directory listing. */
export function scanLangKeysFromPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const key = resolveLangKey(path);
    if (key) {
      seen.add(key);
    }
  }
  return [...seen];
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

/** Register lang keys seen in FileBrowser; prefetches langs module when non-empty. */
export function registerSeenLangKeys(keys: Iterable<string>): void {
  for (const key of keys) {
    sessionSeenLangKeys.add(key);
  }
  if (sessionSeenLangKeys.size > 0) {
    void ensureLangsModule();
  }
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
  const key = resolveLangKey(path, language);
  if (!key) {
    return null;
  }
  return extensionForLangKey(key);
}

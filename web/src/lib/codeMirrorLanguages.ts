import type { Extension } from '@codemirror/state';
import { StreamLanguage, LanguageSupport } from '@codemirror/language';

// Static imports for bundled languages (already in the project)
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';

// Static extension map for bundled languages
const STATIC_EXTS: Record<string, Extension[]> = {
  javascript: [javascript()],
  typescript: [javascript({ typescript: true })],
  python: [python()],
  json: [json()],
  yaml: [yaml()],
  markdown: [markdown()],
  html: [html()],
  css: [css()],
};

// Lazy loader registry for dynamically-loaded languages
type LangLoader = () => Promise<LanguageSupport>;

const LAZY_LOADERS: Record<string, LangLoader> = {
  go:       () => import('@codemirror/lang-go').then(m => m.go()),
  rust:     () => import('@codemirror/lang-rust').then(m => m.rust()),
  cpp:      () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  sql:      () => import('@codemirror/lang-sql').then(m => m.sql()),
  xml:      () => import('@codemirror/lang-xml').then(m => m.xml()),
  java:     () => import('@codemirror/lang-java').then(m => m.java()),
  php:      () => import('@codemirror/lang-php').then(m => m.php()),
};

/** Languages that use @codemirror/legacy-modes instead of official packages. */
const LEGACY_LANGS = new Set([
  'shell', 'ruby', 'swift', 'haskell', 'clojure',
  'r', 'julia', 'lua', 'perl', 'groovy',
]);

/** Load a legacy mode from @codemirror/legacy-modes/mode/<name> and wrap with StreamLanguage. */
function loadLegacyMode(langKey: string): Promise<LanguageSupport> {
  return import(`@codemirror/legacy-modes/mode/${langKey}`)
    .then((mod) => new LanguageSupport(StreamLanguage.define(mod[langKey]), []));
}

const loaded = new Map<string, LanguageSupport>();
const failed = new Set<string>();
const pending = new Map<string, Promise<unknown>>();

// Extension → language key mapping (same as viewerRegistry's EXT_LANG_MAP)
const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  go: 'go',
  rs: 'rust',
  c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  sql: 'sql',
  xml: 'xml',
  java: 'java',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  hs: 'haskell',
  clj: 'clojure', cljs: 'clojure', edn: 'clojure',
  r: 'r',
  jl: 'julia',
  dart: 'dart',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  groovy: 'groovy',
  cs: 'csharp',
};

/**
 * Detect language from filename. Returns 'text' when no match.
 * Synchronous — always returns the correct key even if the language
 * package hasn't loaded yet; getLanguage handles the actual retrieval.
 */
export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === undefined) { return 'text'; }
  return EXT_LANG_MAP[ext] || 'text';
}

/** Resolve a single language key to its LanguageSupport, recording the result. */
function loadLanguage(langKey: string): Promise<void> {
  const load: Promise<LanguageSupport> = LEGACY_LANGS.has(langKey)
    ? loadLegacyMode(langKey)
    : (LAZY_LOADERS[langKey] as LangLoader)();

  return load
    .then((lang) => {
      loaded.set(langKey, lang);
      pending.delete(langKey);
    })
    .catch(() => {
      failed.add(langKey);
      pending.delete(langKey);
    });
}

/** Kick off a language load, deduplicated via the `pending` map. */
function kickOff(langKey: string): void {
  if (loaded.has(langKey) || failed.has(langKey) || pending.has(langKey)) { return; }
  pending.set(langKey, loadLanguage(langKey));
}

/**
 * Preload language packages for the given extensions.
 * Fire-and-forget — call when a directory listing arrives.
 * Already-loaded and already-failed languages are skipped.
 */
export function preload(exts: string[]): void {
  for (const ext of exts) {
    const langKey = EXT_LANG_MAP[ext];
    if (langKey === undefined) { continue; }
    if (!LEGACY_LANGS.has(langKey) && LAZY_LOADERS[langKey] === undefined) { continue; }
    kickOff(langKey);
  }
}

/**
 * Ensure a language is loaded, resolving with its extensions once available.
 * Resolves immediately for static and already-loaded languages, triggers a
 * load for lazy/legacy languages and resolves when it finishes, and resolves
 * `undefined` for 'text', unknown keys, or a failed load. Used by the
 * CodeMirror editor to apply a language that finished loading asynchronously.
 */
export function ensureLanguage(langKey: string): Promise<Extension[] | undefined> {
  if (langKey === 'text') { return Promise.resolve(undefined); }
  if (langKey in STATIC_EXTS) { return Promise.resolve(STATIC_EXTS[langKey]); }

  const loadedLang = loaded.get(langKey);
  if (loadedLang !== undefined) { return Promise.resolve([loadedLang]); }
  if (failed.has(langKey)) { return Promise.resolve(undefined); }

  if (!LEGACY_LANGS.has(langKey) && LAZY_LOADERS[langKey] === undefined) {
    return Promise.resolve(undefined);
  }

  kickOff(langKey);
  return pending.get(langKey)!.then(() => {
    const lang = loaded.get(langKey);
    return lang !== undefined ? [lang] : undefined;
  });
}

/**
 * Synchronously get language extensions for a language key.
 * Returns extensions array for static languages, LanguageSupport for lazy ones,
 * or undefined if the language hasn't loaded yet.
 */
export function getLanguage(langKey: string): Extension[] | undefined {
  // Check static extensions first
  if (langKey in STATIC_EXTS) {
    return STATIC_EXTS[langKey];
  }
  // Check lazy-loaded extensions
  const lang = loaded.get(langKey);
  return lang !== undefined ? [lang] : undefined;
}

/** Diagnostic: list language keys that are currently loaded. */
export function getLoadedLanguages(): string[] {
  return [...Object.keys(STATIC_EXTS), ...loaded.keys()];
}

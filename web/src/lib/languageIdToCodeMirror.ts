/**
 * LanguageId → CodeMirror mapping layer.
 *
 * Maps VS Code-style language identifiers to @uiw/codemirror-extensions-langs keys.
 * This module only provides the mapping — the actual grammar loading lives in codeMirrorLangs.ts.
 *
 * Returns null for:
 * - plaintext (no grammar needed)
 * - LanguageIds without a CodeMirror grammar in @uiw/codemirror-extensions-langs
 * - The special value '__dockerfile__' signals legacy mode loading via @codemirror/legacy-modes
 */

import type { LanguageId } from './languageId';

const LANGUAGE_ID_TO_CODEMIRROR: Partial<Record<LanguageId, string>> = {
  javascript: 'js',
  typescript: 'ts',
  javascriptreact: 'jsx',
  typescriptreact: 'tsx',
  python: 'py',
  ruby: 'rb',
  shellscript: 'sh',
  bash: 'bash',
  zsh: 'sh',
  fish: 'sh',
  go: 'go',
  rust: 'rs',
  markdown: 'md',
  dockerfile: '__dockerfile__',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  java: 'java',
  kotlin: 'kt',
  scala: 'scala',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  'objective-c': 'mm',
  php: 'php',
  lua: 'lua',
  perl: 'pl',
  r: 'r',
  dart: 'dart',
  erlang: 'erl',
  haskell: 'hs',
  clojure: 'clj',
  julia: 'jl',
  fsharp: 'fs',
  ocaml: 'ml',
  groovy: 'groovy',
  vue: 'vue',
  svelte: 'svelte',
  ini: 'ini',
  properties: 'properties',
  env: 'properties',
  protobuf: 'proto',
  cmake: 'cmake',
  powershell: 'ps1',
  diff: 'diff',
  tex: 'tex',
  latex: 'tex',
  vb: 'vb',
  nix: 'nix',
  solidity: 'solidity',
};

/** Map a LanguageId to its @uiw/codemirror-extensions-langs key, or null if unsupported. */
export function languageIdToCodeMirrorKey(languageId: LanguageId): string | null {
  return LANGUAGE_ID_TO_CODEMIRROR[languageId] ?? null;
}

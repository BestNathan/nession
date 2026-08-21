/**
 * LanguageId detection - VS Code-style language identifiers
 * This module provides unified language detection decoupled from CodeMirror grammar loading.
 */

// 66 VS Code-style language identifiers
export type LanguageId =
  | 'plaintext'
  | 'markdown'
  | 'json'
  | 'jsonc'
  | 'typescript'
  | 'typescriptreact'
  | 'javascript'
  | 'javascriptreact'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'scala'
  | 'haskell'
  | 'elixir'
  | 'erlang'
  | 'clojure'
  | 'lua'
  | 'perl'
  | 'r'
  | 'julia'
  | 'dart'
  | 'groovy'
  | 'powershell'
  | 'shellscript'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'dockerfile'
  | 'makefile'
  | 'cmake'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'html'
  | 'css'
  | 'scss'
  | 'less'
  | 'sql'
  | 'graphql'
  | 'diff'
  | 'log'
  | 'ini'
  | 'properties'
  | 'env'
  | 'git-commit'
  | 'git-rebase'
  | 'ignore'
  | 'latex'
  | 'tex'
  | 'vb'
  | 'fsharp'
  | 'ocaml'
  | 'nix'
  | 'terraform'
  | 'protobuf'
  | 'thrift'
  | 'vue'
  | 'svelte';

// Basename priority rules (exact filename matches)
export const BASENAME_RULES: Record<string, LanguageId> = {
  // Docker
  Dockerfile: 'dockerfile',
  'dockerfile': 'dockerfile',

  // Make
  Makefile: 'makefile',
  GNUmakefile: 'makefile',
  makefile: 'makefile',

  // README files
  README: 'markdown',
  'README.md': 'markdown',
  'README.txt': 'markdown',
  'README.rst': 'markdown',

  // Ruby
  Gemfile: 'ruby',
  Rakefile: 'ruby',

  // Jenkins
  Jenkinsfile: 'groovy',

  // CMake
  'CMakeLists.txt': 'cmake',

  // Git
  '.gitignore': 'ignore',
  '.gitattributes': 'plaintext',
  '.gitmodules': 'plaintext',

  // Shell configs
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.profile': 'shellscript',
  '.bash_profile': 'shellscript',
  '.zprofile': 'shellscript',
};

/**
 * Parse the basename from a file path (language detection variant)
 *
 * Note: This differs from viewerRegistry.parseBasename() which uses split/pop.
 * This version uses lastIndexOf for explicit control over path parsing.
 *
 * Examples:
 *   "/path/to/file.txt" -> "file.txt"
 *   "file.txt" -> "file.txt"
 *   ".gitignore" -> ".gitignore"
 *   "" -> ""
 */
export function parseLangBasename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

/**
 * Parse the extension from a file path for language detection (case-sensitive)
 *
 * Note: This differs from viewerRegistry.parseExt() which:
 *   1. Lowercases the result (we preserve case for language detection)
 *   2. Returns "gitignore" for ".gitignore" (we return "" for dotfiles)
 *
 * The dotfile behavior is intentional: files like ".gitignore" are matched
 * by basename rules, not extension rules, in language detection.
 *
 * Examples:
 *   "file.txt" -> "txt"
 *   "file.test.ts" -> "ts"
 *   "Makefile" -> ""
 *   ".gitignore" -> "" (dotfile, no extension)
 *   ".bashrc" -> "" (dotfile, no extension)
 *   "file.MAKEFILE" -> "MAKEFILE" (case preserved)
 */
export function parseLangExt(path: string): string {
  const basename = parseLangBasename(path);
  const lastDot = basename.lastIndexOf('.');
  // No dot, or dot at position 0 (hidden file like .gitignore)
  if (lastDot <= 0) {
    return '';
  }
  return basename.slice(lastDot + 1);
}

/**
 * Detect language from filename
 *
 * Detection priority (execution order):
 *   1. Basename matching (exact filename matches, e.g., "Makefile" -> 'makefile')
 *   2. Extension matching (TODO: not implemented yet)
 *   3. Shebang detection (TODO: not implemented yet)
 *   4. Content-based detection (TODO: not implemented yet)
 *   5. Fallback to 'plaintext'
 *
 * @param filename - File path or basename
 * @returns Detected LanguageId, defaults to 'plaintext'
 */
export function detectLanguage(filename: string): LanguageId {
  // Priority 1: Basename matching
  const basename = parseLangBasename(filename);
  if (basename in BASENAME_RULES) {
    return BASENAME_RULES[basename];
  }

  // TODO: Priority 2 - Extension matching
  // TODO: Priority 3 - Shebang detection
  // TODO: Priority 4 - Content-based detection

  // Priority 5: Fallback
  return 'plaintext';
}

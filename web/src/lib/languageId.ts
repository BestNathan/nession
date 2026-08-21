/**
 * LanguageId detection - VS Code-style language identifiers
 * This module provides unified language detection decoupled from CodeMirror grammar loading.
 */

// ~60 VS Code-style language identifiers
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
  '.gitignore': 'plaintext',
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
 * Parse the basename from a file path
 * Examples:
 *   "/path/to/file.txt" -> "file.txt"
 *   "file.txt" -> "file.txt"
 *   ".gitignore" -> ".gitignore"
 */
export function parseBasename(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

/**
 * Parse the extension from a file path or basename
 * Examples:
 *   "file.txt" -> "txt"
 *   "file.test.ts" -> "ts"
 *   "Makefile" -> ""
 *   ".gitignore" -> "gitignore"
 */
export function parseExt(path: string): string {
  const basename = parseBasename(path);
  const lastDot = basename.lastIndexOf('.');
  // No dot, or dot at position 0 (hidden file like .gitignore)
  if (lastDot <= 0) {
    return '';
  }
  return basename.slice(lastDot + 1);
}

/**
 * Detect language from filename
 * Priority order (for future tasks):
 *   1. Pattern matching (not implemented yet)
 *   2. Basename matching (implemented)
 *   3. Extension matching (not implemented yet)
 *   4. Shebang detection (not implemented yet)
 *   5. Content-based detection (not implemented yet)
 *
 * @param filename - File path or basename
 * @returns Detected LanguageId, defaults to 'plaintext'
 */
export function detectLanguage(filename: string): LanguageId {
  // Priority 2: Basename matching
  const basename = parseBasename(filename);
  if (basename in BASENAME_RULES) {
    return BASENAME_RULES[basename];
  }

  // TODO: Priority 1 - Pattern matching
  // TODO: Priority 3 - Extension matching
  // TODO: Priority 4 - Shebang detection
  // TODO: Priority 5 - Content-based detection

  // Fallback
  return 'plaintext';
}

export const detectLanguage = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    md: 'markdown',
    html: 'html',
    css: 'css',
  };
  return map[ext || ''] || 'text';
};

export const LANGUAGE_EXTENSIONS = [
  'javascript', 'typescript', 'python', 'json', 'yaml',
  'markdown', 'html', 'css', 'shell', 'text',
] as const;

export type SupportedLanguage = (typeof LANGUAGE_EXTENSIONS)[number];

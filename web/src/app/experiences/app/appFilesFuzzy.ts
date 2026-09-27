/** Subsequence fuzzy match — filename and relative path both count (#1140). */
export function fuzzyMatchesFile(query: string, name: string, path: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return true;
  }
  const haystack = `${name} ${path}`.toLowerCase();
  let qi = 0;
  for (let i = 0; i < haystack.length && qi < q.length; i++) {
    if (haystack[i] === q[qi]) {
      qi += 1;
    }
  }
  return qi === q.length;
}

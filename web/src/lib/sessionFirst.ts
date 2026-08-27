const KEY = 'nession_session_first';

function readQuery(): '1' | '0' | null {
  const v = new URLSearchParams(window.location.search).get('session_first');
  if (v === '1' || v === '0') {
    return v;
  }
  return null;
}

export function isSessionFirst(): boolean {
  const q = readQuery();
  if (q !== null) {
    localStorage.setItem(KEY, q);
    return q === '1';
  }
  return localStorage.getItem(KEY) === '1';
}

export function setSessionFirst(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0');
}

/**
 * Copy text to the system clipboard.
 *
 * Uses the async Clipboard API when available (secure contexts). Falls back to
 * a hidden <textarea> + `document.execCommand('copy')` for non-secure contexts
 * (e.g. plain HTTP) where `navigator.clipboard` is undefined.
 */
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      if (document.execCommand('copy')) { resolve(); }
      else { reject(new Error('execCommand returned false')); }
    } catch (e) {
      reject(e);
    } finally {
      document.body.removeChild(ta);
    }
  });
}

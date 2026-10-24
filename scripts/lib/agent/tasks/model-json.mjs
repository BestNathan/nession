// One bounded extraction of a JSON object from Agent model text. Provider
// adapters and task modules share this rule so fenced/embedded output cannot
// be parsed differently by different executors.
export function parseModelJson(raw, label = 'Agent') {
  let text = String(raw ?? '').trim();
  if (!text) throw new Error(label + ' returned empty output');
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(label + ' output did not contain valid JSON');
  }
}


// One bounded, formatting-only retry. The callback receives at most 16 KiB of
// the original output; the caller must not turn a failed repair into a verdict.
export async function parseModelJsonWithRepair(raw, repair, label = 'Agent') {
  try {
    return parseModelJson(raw, label);
  } catch (initialError) {
    if (typeof repair !== 'function') throw initialError;
    const bounded = String(raw ?? '').slice(0, 16 * 1024);
    try {
      const repaired = await repair(bounded);
      return parseModelJson(repaired, label);
    } catch {
      throw new Error(label + ' output remained invalid after one format-repair attempt');
    }
  }
}

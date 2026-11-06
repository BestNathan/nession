import { describe, expect, it } from 'vitest';
import { inspectGitPatch } from '../../components/patchPresentation';

const CHANGED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
].join('\n');

describe('inspectGitPatch', () => {
  it('recognises a patch the renderer can draw', () => {
    const inspection = inspectGitPatch(CHANGED, false);

    expect(inspection.kind).toBe('renderable');
    if (inspection.kind !== 'renderable') {
      return;
    }
    expect(inspection.file.name).toBe('src/a.ts');
    expect(inspection.file.hunks).toHaveLength(1);
  });

  it('keeps binary and empty answers distinct from a patch with no hunks', () => {
    expect(inspectGitPatch('anything', true)).toEqual({ kind: 'binary' });
    expect(inspectGitPatch('', false)).toEqual({ kind: 'empty' });
  });

  it('names a mode-only change instead of presenting it as an empty file', () => {
    const inspection = inspectGitPatch(
      [
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n'),
      false,
    );

    expect(inspection).toEqual({ kind: 'mode-only', from: '100644', to: '100755' });
  });

  it('reports a patch with no textual change as having no lines', () => {
    const inspection = inspectGitPatch(
      [
        'diff --git a/a.txt b/b.txt',
        'similarity index 100%',
        'rename from a.txt',
        'rename to b.txt',
      ].join('\n'),
      false,
    );

    expect(inspection).toEqual({ kind: 'no-lines' });
  });

  it('rejects output that is not one file’s patch', () => {
    expect(inspectGitPatch('not a patch\n', false)).toEqual({ kind: 'malformed' });
  });

  it('rejects a cut hunk instead of drawing the lines that survived', () => {
    // The header promises two deletion and two addition lines; the cap left
    // one of each. Drawing that as the whole change would be the exact
    // false-complete reading #750 C3 forbids.
    const inspection = inspectGitPatch(
      [
        'diff --git a/src/cut.ts b/src/cut.ts',
        'index 1111111..2222222 100644',
        '--- a/src/cut.ts',
        '+++ b/src/cut.ts',
        '@@ -1,2 +1,2 @@',
        '-const before = 1;',
        '+const after = 2;',
      ].join('\n'),
      false,
    );

    expect(inspection).toEqual({ kind: 'malformed' });
  });
});

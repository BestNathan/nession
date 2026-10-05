import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanCssSource,
  scanVisualVocabularySuppression,
} from './visual-vocabulary-source.mjs';

const metadata = {
  cssVariables: ['--nession-background', '--nession-radius-control'],
  legacyCssVariables: ['--background', '--radius-control'],
};

test('CSS source gate accepts canonical, local and framework adapter variables', () => {
  const source = `
@theme inline {
  --font-sans: Inter, sans-serif;
  --radius-md: var(--nession-radius-control);
}
.probe {
  --nession-local-probe-width: 12rem;
  color: var(--nession-background);
  width: var(--nession-local-probe-width);
}
`;
  assert.deepEqual(scanCssSource(source, 'web/src/index.css', metadata), []);
});

test('CSS source gate rejects legacy and unowned custom properties', () => {
  const violations = scanCssSource(
    `
.probe {
  --probe-width: 12rem;
  color: var(--background);
  width: var(--probe-width);
}
`,
    'web/src/index.css',
    metadata,
  );
  assert.deepEqual(
    violations.map((v) => v.kind),
    ['foreign-definition', 'legacy-reference', 'foreign-reference'],
  );
  assert.match(violations[1].repair, /--nession-background/);
});

test('visual vocabulary rule cannot be disabled in a consumer', () => {
  const violations = scanVisualVocabularySuppression(
    '// eslint-disable-next-line nession/visual-vocabulary\nconst x = 1;',
    'web/src/product/probe.ts',
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'local-suppression');
  assert.match(violations[0].repair, /adapter boundary/);
});

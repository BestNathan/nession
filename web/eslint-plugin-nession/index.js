import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import noCrossExperienceToken from './rules/no-cross-experience-token.js';
import noCapsuleMagicMetrics from './rules/no-capsule-magic-metrics.js';
import noSfOverlayVars from './rules/no-sf-overlay-vars.js';
import noReverseImports from './rules/no-reverse-imports.js';
import noUiProductImports from './rules/no-ui-product-imports.js';
import noDeepCapabilityImports from './rules/no-deep-capability-imports.js';
import noCapabilityPortals from './rules/no-capability-portals.js';
import visualVocabulary from './rules/visual-vocabulary.js';

const metadataPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../design/generated/lint-metadata.json',
);
const lintMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));

const plugin = {
  meta: {
    name: 'eslint-plugin-nession',
    version: '1.0.0',
  },
  rules: {
    'no-cross-experience-token': noCrossExperienceToken(lintMetadata),
    'no-capsule-magic-metrics': noCapsuleMagicMetrics(),
    'no-sf-overlay-vars': noSfOverlayVars(),
    'no-reverse-imports': noReverseImports,
    'no-ui-product-imports': noUiProductImports,
    'no-deep-capability-imports': noDeepCapabilityImports,
    'no-capability-portals': noCapabilityPortals,
    'visual-vocabulary': visualVocabulary(lintMetadata),
  },
};

export default plugin;

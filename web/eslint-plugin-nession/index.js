import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import noPrimitiveTokens from './rules/no-primitive-tokens.js';
import noCrossExperienceToken from './rules/no-cross-experience-token.js';
import noCapsuleMagicMetrics from './rules/no-capsule-magic-metrics.js';
import noSfOverlayVars from './rules/no-sf-overlay-vars.js';

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
    'no-primitive-tokens': noPrimitiveTokens(lintMetadata),
    'no-cross-experience-token': noCrossExperienceToken(lintMetadata),
    'no-capsule-magic-metrics': noCapsuleMagicMetrics(),
    'no-sf-overlay-vars': noSfOverlayVars(),
  },
};

export default plugin;

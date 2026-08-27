import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import noPrimitiveTokens from './rules/no-primitive-tokens.js';
import noCrossExperienceToken from './rules/no-cross-experience-token.js';

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
  },
};

export default plugin;

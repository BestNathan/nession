import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import noPrimitiveTokens from './rules/no-primitive-tokens.js';
import noCrossExperienceToken from './rules/no-cross-experience-token.js';
import noCapsuleMagicMetrics from './rules/no-capsule-magic-metrics.js';
import noCapsuleControlBand, { controlVarFromTokenId } from './rules/no-capsule-control-band.js';
import noSfOverlayVars from './rules/no-sf-overlay-vars.js';
import noReverseImports from './rules/no-reverse-imports.js';

const metadataPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../design/generated/lint-metadata.json',
);
const lintMetadata = JSON.parse(readFileSync(metadataPath, 'utf8'));

// The control band the capsule must compose comes from the resolved contract,
// not from a list kept here. `design/generated/contracts.json` is generated
// from design/contracts/, so changing the pattern changes this rule (#759 SC6).
const contractsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../design/generated/contracts.json',
);
const resolvedContracts = JSON.parse(readFileSync(contractsPath, 'utf8'));

function capsuleControlBand() {
  const block = resolvedContracts.patterns?.['pattern.terminal-capsule'];
  if (!block) {
    throw new Error(
      'design/generated/contracts.json has no pattern.terminal-capsule — ' +
        'run `just contracts-gen` (the capsule control-band rule reads its heightToken).',
    );
  }
  const bands = ['web', 'app']
    .map((experience) => controlVarFromTokenId(block[experience]?.heightToken))
    .filter(Boolean);
  const unique = [...new Set(bands)];
  if (unique.length !== 1) {
    throw new Error(
      `pattern.terminal-capsule declares conflicting control bands across experiences: ${unique.join(', ')}. ` +
        'no-capsule-control-band can only enforce one.',
    );
  }
  return { allowedBands: unique, tokenId: block.app?.heightToken ?? block.web?.heightToken, pattern: block.id };
}

const plugin = {
  meta: {
    name: 'eslint-plugin-nession',
    version: '1.0.0',
  },
  rules: {
    'no-primitive-tokens': noPrimitiveTokens(lintMetadata),
    'no-cross-experience-token': noCrossExperienceToken(lintMetadata),
    'no-capsule-magic-metrics': noCapsuleMagicMetrics(),
    'no-capsule-control-band': noCapsuleControlBand(capsuleControlBand()),
    'no-sf-overlay-vars': noSfOverlayVars(),
    'no-reverse-imports': noReverseImports,
  },
};

export default plugin;

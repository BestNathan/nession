// Assert the control band a capsule control *names*, not the px it happens to
// resolve to (#742, #759 SC6).
//
// The contract records both the token and its resolved value
// (`heightToken: "experience.app.control.md"`, `heightTokenPx: 44`). The
// viewport matrix only measured the px, and on App `control.sm` and
// `control.md` are *both* 44px — so a control that composed the wrong band
// produced the right number and passed. The moment the two bands diverge, the
// 44px touch floor is silently lost.
//
// The fix is to check the name. The allowed band is not restated here: it is
// read from the resolved contract (`design/generated/contracts.json`), which is
// what the pattern layer owns. Change the contract and this rule follows.
//
// Only the *height* axis is checked. `--control-sm` is legitimately used for
// min-width in the capsule (a narrower keycap is not a band violation), so
// matching every `control-*` reference would flag correct code.

import { cssVarFromTokenId } from '../../../design/scripts/generate-tokens.mjs';

const CAPSULE_GLOB = 'src/features/terminal/capsule/';

// `experience.app.control.md` → `control-md`, derived by the generator itself.
// Re-implementing the camelCase→kebab step here would be a second naming scheme
// that could drift from the custom property the component actually composes —
// the failure mode this whole rule exists to catch.
export const controlVarFromTokenId = cssVarFromTokenId;

// `h-[length:var(--control-md)]` and `min-h-[length:var(--control-md)]`.
// `min-w-`/`w-` deliberately do not match — see the note above.
const HEIGHT_BAND_RE = /\b(?:min-)?h-\[[^\]]*var\(--(control-[a-z0-9-]+)\)/g;

export function findControlBandViolation(value, allowedBands) {
  if (typeof value !== 'string' || allowedBands.length === 0) {
    return null;
  }
  HEIGHT_BAND_RE.lastIndex = 0;
  let match;
  while ((match = HEIGHT_BAND_RE.exec(value)) !== null) {
    const band = match[1];
    if (!allowedBands.includes(band)) {
      return { found: band, expected: allowedBands[0] };
    }
  }
  return null;
}

function isCapsuleFile(filename) {
  const normalized = filename.replace(/\\/g, '/');
  return (
    normalized.includes(CAPSULE_GLOB) &&
    !normalized.includes('/__tests__/') &&
    !/\.(test|spec)\.[jt]sx?$/.test(normalized)
  );
}

export default function noCapsuleControlBand(contract) {
  const allowedBands = contract?.allowedBands ?? [];

  return {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Require capsule control heights to name the contract control band, not merely resolve to its px',
      },
      schema: [],
      messages: {
        band: [
          'Capsule control height names var(--{{found}}), but {{pattern}} declares heightToken {{tokenId}} → var(--{{expected}}).',
          '',
          'px equality does not make the semantic token correct: on the App experience',
          'control.sm and control.md both resolve to 44px, so no pixel assertion can tell',
          'them apart (#742).',
          '',
          'owner:  design/contracts/patterns/terminal-capsule.json',
          'repair: compose var(--{{expected}}); if the band is genuinely wrong, change the',
          '        contract rather than the component.',
          '',
          'nession/no-capsule-control-band',
        ].join('\n'),
      },
    },
    create(context) {
      const filename = context.filename ?? '';
      if (!isCapsuleFile(filename)) {
        return {};
      }

      function check(node, value) {
        const hit = findControlBandViolation(value, allowedBands);
        if (!hit) {
          return;
        }
        context.report({
          node,
          messageId: 'band',
          data: {
            found: hit.found,
            expected: hit.expected,
            tokenId: contract.tokenId,
            pattern: contract.pattern,
          },
        });
      }

      return {
        Literal(node) {
          check(node, node.value);
        },
        TemplateLiteral(node) {
          for (const quasi of node.quasis) {
            check(quasi, quasi.value.cooked ?? quasi.value.raw);
          }
        },
      };
    },
  };
}

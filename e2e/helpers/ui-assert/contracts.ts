// Loads merged UI contracts (#545) + resolved token px for the assertion
// framework (#546). Single source: design/generated/contracts.json — never
// redefine design values in e2e specs.
//
// __dirname (not import.meta): playwright transforms specs/helpers to CJS —
// this package.json is not "type": "module" (same convention as
// playwright.config.ts which also uses __dirname).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
declare const __dirname: string;
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONTRACTS_PATH = join(REPO_ROOT, 'design', 'generated', 'contracts.json');

export type Experience = 'web' | 'app';

export interface ContractBlock {
  wrap?: boolean;
  heightToken?: string;
  heightTokenPx?: number;
  minHeightToken?: string;
  minHeightTokenPx?: number;
  overflow?: 'clip' | 'menu' | 'sheet' | 'scroll' | 'wrap';
  alignY?: 'top' | 'middle' | 'bottom';
  justify?: 'start' | 'center' | 'end' | 'space-between' | 'space-around';
  minWidthToken?: string;
  minWidthTokenPx?: number;
  maxWidthToken?: string;
  maxWidthTokenPx?: number;
  scrollOwner?: boolean | string;
  touchTargetToken?: string;
  touchTargetTokenPx?: number;
  visibility?: { mode: string; breakpoint?: string };
}

export interface MergedPattern {
  id: string;
  patternRef: string;
  extends: string[];
  web: ContractBlock;
  app: ContractBlock;
}

/** One row of the canonical validation matrix (design/contracts/viewports.json). */
export interface ViewportEntry {
  id: string;
  experience: Experience;
  role: string;
  width: number;
  height: number;
}

export interface ContractsFile {
  $note: string;
  viewports: ViewportEntry[];
  patterns: Record<string, MergedPattern>;
}

let cached: ContractsFile | null = null;

/** Merged contracts from design/generated/contracts.json (#545, drift-gated in web-lint). */
export function loadContracts(): ContractsFile {
  if (cached === null) {
    cached = JSON.parse(readFileSync(CONTRACTS_PATH, 'utf8')) as ContractsFile;
  }
  return cached;
}

export function patternBlock(patternId: string, experience: Experience): ContractBlock {
  const merged = loadContracts().patterns[patternId];
  if (merged === undefined) {
    throw new Error(
      `unknown pattern contract "${patternId}" — no entry in design/generated/contracts.json\n` +
        '  Fix: add design/contracts/patterns/<id>.json and run: node design/scripts/resolve-contracts.mjs',
    );
  }
  return merged[experience];
}

/** Contract block with a per-call override (used by broken-fixture proofs). */
export function contractFor(
  patternId: string,
  experience: Experience,
  overrides: Partial<ContractBlock> = {},
): ContractBlock {
  return { ...patternBlock(patternId, experience), ...overrides };
}

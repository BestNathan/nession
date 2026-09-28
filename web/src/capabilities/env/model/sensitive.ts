/**
 * Sensitive-looking variable classification (#1202).
 *
 * The one place the KEY/TOKEN/SECRET/PASSWORD/AUTH/CREDENTIAL families are
 * named — the read-first Variables view masks matching values by default, and
 * no render code may carry its own copy of the heuristic. Masking is a display
 * affordance, not encryption: the value is in memory and the raw file is
 * readable, so nothing here may be described as security-at-rest.
 */

const SENSITIVE_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i;

/** Whether a variable key names something that looks like a secret. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * What a masked value renders as. Fixed length on purpose: echoing the real
 * length back would leak it, and a bullet count that varies by value reads as
 * information rather than as a mask.
 */
export const MASKED_VALUE = '••••••••';

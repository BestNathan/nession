import { describe, it, expect } from 'vitest';
import { measureLineCount } from '@/session-first/capsule/measure/measureLineCount';
import { WEB_COMPOSER_METRICS } from '@/session-first/capsule/measure/__fixtures__/metrics';

describe('measureLineCount', () => {
  it('forces 1 line when value is empty even if scrollHeight looks multi-line', () => {
    expect(measureLineCount('', 52, WEB_COMPOSER_METRICS)).toBe(1);
    expect(measureLineCount('', 40, WEB_COMPOSER_METRICS)).toBe(1);
  });

  it('keeps single-line content at 1 when scrollHeight is within the single-line band', () => {
    expect(measureLineCount('hello', WEB_COMPOSER_METRICS.controlHeight, WEB_COMPOSER_METRICS)).toBe(1);
    expect(
      measureLineCount(
        'hello',
        WEB_COMPOSER_METRICS.controlHeight + WEB_COMPOSER_METRICS.singleHeightTolerance,
        WEB_COMPOSER_METRICS,
      ),
    ).toBe(1);
  });

  it('counts hard breaks and real multi-line height', () => {
    expect(measureLineCount('a\nb', 52, WEB_COMPOSER_METRICS)).toBe(2);
    expect(measureLineCount('wraps without break', 52, WEB_COMPOSER_METRICS)).toBe(2);
  });
});

'use strict';
// #2876 SC-03: authorized untracked media reaches the existing Files viewers
// with real bytes and working controls. Mismatched or oversized content is a
// truthful bounded fallback, never a broken/empty viewer.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

test('SC-03: image/video/audio/PDF use real bytes and bounded fallbacks', async ({ page }) => {
  test.setTimeout(180_000);
  const { sha } = verifiedRuntime('SC-03');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/fixture/workspace?capability=git&git=preview-states');
  await page.getByTestId('git-change-list').waitFor();
  const row = (path) => page.getByTestId('git-row-untracked').filter({ hasText: path });

  // Image: decoded 16x16 sample, with the existing zoom/fit controls.
  await row('assets/photo.png').click();
  const image = page.getByTestId('image-viewer');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el) => el.naturalWidth)).toBe(16);
  await expect.poll(() => image.evaluate((el) => el.naturalHeight)).toBe(16);
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fit to screen' })).toBeVisible();
  await expect(page.getByTestId('git-file-preview-text')).toHaveCount(0);

  // Video: a real VP8 WebM whose metadata decodes in the browser.
  await row('assets/sample.webm').click();
  const video = page.getByTestId('video-viewer');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('controls', '');
  await expect.poll(() => video.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => video.evaluate((el) => el.videoWidth)).toBe(16);

  // Audio: a real WAV with a finite, non-zero duration.
  await row('assets/sample.wav').click();
  const audio = page.getByTestId('audio-viewer');
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute('controls', '');
  await expect.poll(() => audio.evaluate((el) => el.readyState)).toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => audio.evaluate((el) => (Number.isFinite(el.duration) ? el.duration : 0)))
    .toBeGreaterThan(0);

  // PDF: the existing embed viewer with the PDF MIME, backed by a Blob URL.
  await row('assets/spec.pdf').click();
  const pdf = page.getByTestId('pdf-viewer');
  await expect(pdf).toBeVisible();
  await expect(pdf).toHaveAttribute('type', 'application/pdf');
  await expect(pdf).toHaveAttribute('src', /^blob:/);

  // Mismatched content: no viewer is fabricated.
  await row('assets/fake.png').click();
  await expect(page.getByTestId('git-file-preview-message')).toContainText(
    'does not match its extension',
  );
  await expect(page.getByTestId('image-viewer')).toHaveCount(0);

  // Out-of-policy size: an explicit bounded state, not a truncated viewer.
  await row('assets/oversized.png').click();
  await expect(page.getByTestId('git-file-preview-message')).toContainText('larger than');
  await expect(page.getByTestId('image-viewer')).toHaveCount(0);

  test.info().annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': a 16x16 PNG decoded in the image viewer with zoom/fit controls, a real ' +
      'VP8 WebM reported 16px video metadata, a real WAV had a finite duration, the PDF opened in the ' +
      'PDF embed, and mismatched/oversized bytes produced explicit bounded messages with no viewer',
  });
});

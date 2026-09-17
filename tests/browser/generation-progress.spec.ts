import { assertPatternEquivalent } from '../support/pattern-assertions';
import { test, expect } from '@playwright/test';
import { createTextFixtures, textFixtureRequest } from '../../benchmark/text-fixtures';
import { generatePattern, toJsonRequest } from '../../src/beadify/core';

test('actual Worker reports monotonic generation work, preserves output and can cancel during progress', async ({ page }) => {
  test.setTimeout(60000);
  const fixture = createTextFixtures().find(f => f.id === 'disconnected-han')!;
  const request = toJsonRequest({ ...textFixtureRequest(fixture.image, 24), optimization: { maxEvaluations: 3000 } });
  const expected = generatePattern(request);
  await page.goto('/');
  const actual = await page.evaluate(async request => {
    const { GenerationWorkerClient } = await import('/src/beadify/worker-client.js');
    const client = new GenerationWorkerClient(), updates: any[] = [];
    const pattern = await client.generate(request, (progress: any) => updates.push(progress));
    let afterCancel = 0;
    const cancelled = await client.generate(request, () => { afterCancel++; client.cancel(); }).then(() => 'unexpected completion', (e: Error) => e.message);
    return { pattern, updates, cancelled, afterCancel };
  }, request);
  assertPatternEquivalent(actual.pattern, expected);
  expect(actual.updates.some(p => p.stage === 'optimizing' && p.evaluations !== undefined)).toBe(true);
  const ratios = actual.updates.map(p => p.completed / p.total);
  expect(ratios).toEqual([...ratios].sort((a, b) => a - b)); expect(ratios.at(-1)).toBe(1);
  expect(actual.cancelled).toContain('cancelled'); expect(actual.afterCancel).toBe(1);
});

for (const method of ['original', 'optimized']) test(`${method} generation shows a live progress bar and clears it on cancel`, async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).generationValues = [];
    new MutationObserver(() => {
      const bar = document.querySelector('progress[aria-label="图案生成进度"]') as HTMLProgressElement | null;
      if (bar) (window as any).generationValues.push(bar.value);
    }).observe(document.body, { attributes: true, childList: true, subtree: true });
  });
  await page.getByLabel('Generation algorithm').selectOption(method);
  await page.getByLabel('Output width', { exact: true }).fill('64');
  await page.getByLabel('Output height', { exact: true }).fill('64');
  await page.getByLabel('Color limit value', { exact: true }).fill('8');
  await page.getByTestId('generation-file').setInputFiles('benchmark/text/disconnected-han.source.png');
  const bar = page.getByRole('progressbar', { name: '图案生成进度', exact: true });
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('generation-candidate')).toBeVisible({ timeout: 45000 });
  await expect(bar).toHaveAttribute('value', '100');
  const values = await page.evaluate(() => (window as any).generationValues as number[]);
  expect(values.some(v => v > 0 && v < 100)).toBe(true);
  expect(values.every(v => v >= 0 && v <= 100)).toBe(true);
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByTestId('generation-candidate')).toHaveCount(0);
});

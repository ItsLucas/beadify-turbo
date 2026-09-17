import { test, expect, type Page } from '@playwright/test';
const draft = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')!));

test('white margins disappear from generated beads while interior white remains; crop survives save and undo', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await page.getByLabel('Generation algorithm').selectOption('area');
  await page.getByLabel('Output width', { exact: true }).fill('32');
  await page.getByLabel('Output height', { exact: true }).fill('24');
  await page.getByLabel('Color limit value', { exact: true }).fill('8');
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 32, 24);
    ctx.fillStyle = '#ddb383'; ctx.fillRect(4, 4, 24, 16);
    ctx.fillStyle = '#fff'; ctx.fillRect(12, 9, 4, 4);
    ctx.fillStyle = '#111'; ctx.fillRect(21, 8, 2, 8);
    return Array.from(new Uint8Array(await (await new Promise<Blob>(r => canvas.toBlob(b => r(b!)))).arrayBuffer()));
  });
  await page.getByTestId('generation-file').setInputFiles({ name: 'white-frame.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const before = await draft(page);
  const whiteCell = before.cells.find(Boolean); // Physical palette whites are approximate RGB.
  expect(before.cells.filter((c: string) => c === whiteCell).length).toBeGreaterThan(100);
  await page.getByRole('button', { name: '裁切白色边框', exact: true }).click();
  await expect(page.getByLabel('主体背景', { exact: true })).toHaveValue('keep');
  await expect(page.getByTestId('generation-candidate')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const cropped = await draft(page);
  expect(cropped.beadify.generationSettings.preprocessing.crop).toEqual([4, 4, 28, 20]);
  expect(cropped.beadify.sourceRaster.geometry.crop).toEqual([4, 4, 28, 20]);
  const whites = cropped.cells.filter((c: string) => c === whiteCell).length;
  expect(whites).toBeGreaterThan(0); expect(whites).toBeLessThan(60);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await draft(page)).cells).toEqual(before.cells);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await draft(page)).cells).toEqual(cropped.cells);
  await page.reload();
  expect((await draft(page)).beadify.generationSettings.preprocessing.crop).toEqual([4, 4, 28, 20]);
  expect((await draft(page)).cells).toEqual(cropped.cells);
});

test('retyping defaults to surrounding background and saves the chosen edge-transition mode', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByLabel('Generation algorithm').selectOption('optimized');
  await page.getByLabel('Output width', { exact: true }).fill('40');
  await page.getByLabel('Output height', { exact: true }).fill('40');
  await page.getByLabel('Color limit value', { exact: true }).fill('16');
  await page.getByTestId('generation-file').setInputFiles('benchmark/text/disconnected-han.source.png');
  await expect(page.getByTestId('generation-candidate')).toBeVisible({ timeout: 30000 });
  await page.getByLabel('Import text analysis', { exact: true }).setInputFiles('benchmark/text/interfaces-v1/disconnected-han.analysis.json');
  await expect(page.getByLabel('Retype background mode')).toHaveValue('surrounding');
  await expect(page.getByLabel('Retype background', { exact: true })).toHaveCount(0);
  await page.getByLabel('Retype content').fill('HI');
  await page.getByLabel('Retype background mode').selectOption('blend-color');
  await expect(page.getByLabel('Retype background', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '生成重新排字候选', exact: true }).click();
  await expect(page.getByRole('group', { name: '文字增强候选比较', exact: true }).getByRole('button')).toHaveCount(3, { timeout: 30000 });
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const saved = await draft(page);
  expect(saved.beadify.textRetype.backgroundMode).toBe('blend-color');
  await page.getByLabel('Retype background mode').selectOption('surrounding');
  await page.getByTestId('project-file').setInputFiles({ name: 'background-mode.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await expect(page.getByLabel('Retype background mode')).toHaveValue('blend-color');
  await page.reload();
  await expect(page.getByLabel('Retype background mode')).toHaveValue('blend-color');
});

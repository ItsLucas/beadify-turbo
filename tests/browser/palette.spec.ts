import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { basicPalette, completePalette } from '../../src/palette';
import { createProject, projectWithSnapshot, serializeProject, withCells } from '../../src/project';

async function draft(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')!));
}
async function exportProject(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出编辑', exact: true }).click();
  return readFile((await (await downloadPromise).path())!);
}
function uniqueCodes(project: { cells: Array<string | null> }) {
  return [...new Set(project.cells.filter(Boolean))].sort();
}
async function basicSwatchPng(page: Page) {
  // Every basic color has a distinct RGB; each source pixel should map to its own code.
  const bytes = await page.evaluate(async colors => {
    const canvas = document.createElement('canvas'); canvas.width = 17; canvas.height = 13;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(17, 13);
    colors.forEach((rgb, index) => pixels.data.set([...rgb, 255], index * 4));
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, basicPalette.map(color => color.rgb));
  return Buffer.from(bytes);
}

test('Web exposes every basic221 and complete291 code with matching generation and layer caps', async ({ page }) => {
  await page.goto('/');
  const mode = page.getByLabel('Palette mode', { exact: true });
  const limit = page.getByLabel('Color limit', { exact: true });
  const numeric = page.getByLabel('Color limit value', { exact: true });
  const codes = page.locator('.palette-grid .swatch small');
  await expect(mode).toHaveValue('basic');
  await expect(codes).toHaveCount(221);
  expect(await codes.allTextContents()).toEqual(basicPalette.map(color => color.primaryCode));
  await expect(limit).toHaveAttribute('max', '221');
  await expect(numeric).toHaveAttribute('max', '221');
  await expect(numeric).toHaveValue('12');
  await numeric.fill('80');
  await expect(limit).toHaveValue('80');
  await page.locator('summary').filter({ hasText: '色卡与重算选项' }).click();
  await page.getByLabel('Allowed colors', { exact: true }).fill('A1, H7');
  await page.getByRole('button', { name: '使用全部221色', exact: true }).click();
  await expect(numeric).toHaveValue('221');
  await expect(page.getByLabel('Allowed colors', { exact: true })).toHaveValue('');

  await mode.selectOption('complete');
  await expect(codes).toHaveCount(291);
  expect(await codes.allTextContents()).toEqual(completePalette.map(color => color.primaryCode));
  await expect(limit).toHaveAttribute('max', '291');
  await expect(numeric).toHaveAttribute('max', '291');
  await expect(numeric).toHaveValue('221');
  await page.getByRole('button', { name: '使用全部291色', exact: true }).click();
  await expect(numeric).toHaveValue('291');
  await page.getByRole('tab', { name: '调整', exact: true }).click();
  await expect(page.getByLabel('Layer color limit', { exact: true })).toHaveAttribute('max', '291');
  await page.getByLabel('Layer color limit value', { exact: true }).fill('280');
  await expect(page.getByLabel('Layer color limit', { exact: true })).toHaveValue('280');
  await page.getByRole('tab', { name: '调色盘', exact: true }).click();
  await mode.selectOption('basic');
  await expect(numeric).toHaveValue('221');
  await expect(limit).toHaveAttribute('max', '221');
  await expect(codes).toHaveCount(221);
  await page.getByRole('tab', { name: '调整', exact: true }).click();
  await expect(page.getByLabel('Layer color limit', { exact: true })).toHaveAttribute('max', '221');
  await expect(page.getByLabel('Layer color limit value', { exact: true })).toHaveValue('221');
});

test('area Worker preserves all221 source swatches through preview, layers, save and reload', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [], workers: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => workers.push(worker.url()));
  await page.goto('/');
  await page.getByLabel('Generation algorithm', { exact: true }).selectOption('area');
  await page.getByLabel('Output width', { exact: true }).fill('17');
  await page.getByLabel('Output height', { exact: true }).fill('13');
  await page.getByLabel('Color limit value', { exact: true }).fill('64');
  const buffer = await basicSwatchPng(page);
  await page.getByTestId('generation-file').setInputFiles({ name: 'basic-221-original-swatches.png', mimeType: 'image/png', buffer });
  await expect(page.getByTestId('generation-candidate')).toContainText('64 色');
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  await expect.poll(async () => uniqueCodes(await draft(page)).length).toBe(64);
  expect((await draft(page)).beadify.generationSettings.maxColors).toBe(64);

  await page.getByRole('button', { name: '使用全部221色', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toContainText('221 色');
  const preview = await page.getByLabel('Candidate preview', { exact: true }).evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width, height: canvas.height,
    rgba: Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data),
  }));
  expect(preview).toEqual({ width: 17, height: 13, rgba: basicPalette.flatMap(color => [...color.rgb, 255]) });
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const expectedIds = basicPalette.map(color => color.id).sort();
  await expect.poll(async () => uniqueCodes(await draft(page))).toEqual(expectedIds);
  const accepted = await draft(page);
  expect(accepted.beadify.generationSettings).toMatchObject({ method: 'area', maxColors: 221 });
  expect(accepted.beadify.generationSettings.allowedColors).toHaveLength(221);
  expect(workers.some(url => url.endsWith('/generation.worker.js'))).toBe(true);
  await page.getByLabel('Color limit value', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'generated/full-palette-workbench.png', fullPage: true });

  // A layer's full-palette setting must not hide a second internal48 clamp.
  await page.getByRole('tab', { name: '调整', exact: true }).click();
  await page.getByLabel('Layer color limit value', { exact: true }).fill('221');
  await page.getByRole('button', { name: '应用色数上限', exact: true }).click();
  expect((await draft(page)).cells).toEqual(accepted.cells);
  await page.getByLabel('Layer color limit value', { exact: true }).fill('64');
  await page.getByRole('button', { name: '应用色数上限', exact: true }).click();
  await expect.poll(async () => uniqueCodes(await draft(page)).length).toBe(64);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await draft(page)).cells).toEqual(accepted.cells);

  const saved = await exportProject(page), savedProject = JSON.parse(saved.toString());
  expect(uniqueCodes(savedProject)).toEqual(expectedIds);
  expect(savedProject.beadify.generationSettings.maxColors).toBe(221);
  await page.getByTestId('project-file').setInputFiles({ name: 'all221-roundtrip.json', mimeType: 'application/json', buffer: saved });
  await expect(page.getByLabel('Color limit value', { exact: true })).toHaveValue('221');
  await page.reload();
  await expect(page.getByLabel('Palette mode', { exact: true })).toHaveValue('basic');
  await expect(page.getByLabel('Color limit', { exact: true })).toHaveValue('221');
  await expect(page.getByLabel('Color limit value', { exact: true })).toHaveValue('221');
  expect(uniqueCodes(await draft(page))).toEqual(expectedIds);
  expect((await draft(page)).cells).toEqual(accepted.cells);
  expect(errors).toEqual([]);
});

test('full291 project roundtrip retains every code including equal-RGB Q4 and R11', async ({ page }) => {
  let project = projectWithSnapshot(withCells(createProject(97, 3, 'All 291 bead codes'), completePalette.map(color => color.id)));
  project = { ...project, beadify: { ...project.beadify!, generationSettings: {
    method: 'area', width: 97, height: 3, maxColors: 291,
    allowedColors: project.beadify!.paletteSnapshot.colors.map(color => color.id) as [string, ...string[]],
  } } };
  await page.goto('/');
  await page.getByTestId('project-file').setInputFiles({ name: 'all291-project.json', mimeType: 'application/json', buffer: Buffer.from(serializeProject(project)) });
  const expectedIds = completePalette.map(color => color.id).sort();
  await expect(page.getByLabel('Palette mode', { exact: true })).toHaveValue('complete');
  await expect(page.getByLabel('Color limit value', { exact: true })).toHaveValue('291');
  await expect(page.locator('.palette-grid .swatch')).toHaveCount(291);
  expect(uniqueCodes(await draft(page))).toEqual(expectedIds);
  const saved = JSON.parse((await exportProject(page)).toString());
  expect(uniqueCodes(saved)).toEqual(expectedIds);
  expect(saved.beadify.paletteSnapshot.colors).toHaveLength(291);
  const q4 = saved.beadify.paletteSnapshot.colors.find((color: { code: string }) => color.code === 'Q4');
  const r11 = saved.beadify.paletteSnapshot.colors.find((color: { code: string }) => color.code === 'R11');
  expect(q4.srgb8).toEqual(r11.srgb8);
  expect(q4.id).not.toBe(r11.id);
  await page.reload();
  await expect(page.getByLabel('Palette mode', { exact: true })).toHaveValue('complete');
  await expect(page.getByLabel('Color limit', { exact: true })).toHaveValue('291');
  await expect(page.getByLabel('Color limit value', { exact: true })).toHaveValue('291');
  expect(uniqueCodes(await draft(page))).toEqual(expectedIds);
});

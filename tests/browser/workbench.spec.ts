import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { generatePattern } from '../../src/beadify/core/index';

// Tiny original RGBA pattern encoded by the browser, independent of private artwork.
async function fixture(page: any) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffdc35'; context.fillRect(2, 2, 12, 12);
    context.fillStyle = '#000000'; context.fillRect(4, 5, 3, 3); context.fillRect(10, 5, 3, 3);
    context.fillStyle = '#ffffff'; context.fillRect(5, 5, 1, 1); context.fillRect(11, 5, 1, 1);
    return Array.from(new Uint8Array(await (await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)))).arrayBuffer()));
  });
}
async function draft(page: any) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')!));
}

test('candidate accept/reject, undo/redo, reload, project export and visible BOM', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || url.protocol === 'blob:' || url.protocol === 'data:' ? route.continue() : route.abort();
  });
  await page.goto('/');
  const original = await draft(page);
  await page.getByLabel('Generation algorithm').selectOption('area');
  const bytes = await fixture(page);
  await page.getByTestId('generation-file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  expect((await draft(page)).cells).toEqual(original.cells);
  await page.getByRole('button', { name: '拒绝候选', exact: true }).click();
  expect((await draft(page)).cells).toEqual(original.cells);
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toHaveCount(0);
  const accepted = await draft(page);
  expect(accepted.layers).toHaveLength(2);
  expect(accepted.cells.some(Boolean)).toBe(true);
  expect(accepted.beadify.schemaVersion).toBe(1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await draft(page)).cells).toEqual(original.cells);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await draft(page)).cells).toEqual(accepted.cells);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出编辑', exact: true }).click();
  const download = await downloadPromise;
  const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(saved.cells).toEqual(accepted.cells);
  await page.reload();
  expect((await draft(page)).cells).toEqual(accepted.cells);
  const bomPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '可见图纸 BOM', exact: true }).click();
  const csv = await readFile((await (await bomPromise).path())!, 'utf8');
  const sum = csv.trim().split(/\r?\n/).slice(1).reduce((n, row) => n + Number(row.split(',').at(-1)), 0);
  expect(sum).toBe(accepted.cells.filter(Boolean).length);
  await page.getByTestId('project-file').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  expect((await draft(page)).beadify).toEqual(accepted.beadify);
  expect(errors).toEqual([]);
  // Capture the visible workspace; extending the canvas-heavy page to its full
  // scroll height can stall software Chromium after the interaction checks.
  await page.screenshot({ path: 'generated/beadify-workbench.png' });
});

test('edits invalidate candidates and original algorithm remains available', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Generation algorithm').selectOption('area');
  const bytes = await fixture(page);
  await page.getByTestId('generation-file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  // A document change must invalidate an already completed candidate.
  await page.getByLabel('Canvas width', { exact: true }).fill('40');
  await page.getByRole('button', { name: '应用', exact: true }).first().click();
  await expect(page.getByTestId('generation-candidate')).toHaveCount(0);
  await page.getByLabel('Generation algorithm').selectOption('original');
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  expect((await draft(page)).beadify.lastGeneration.method).toBe('original');
});

test('actual browser Worker matches Node core and keeps the source buffer', async ({ page }) => {
  await page.goto('/');
  const input = {
    schemaVersion: 1 as const, revision: 4, image: { width: 2, height: 1, data: [255, 0, 0, 255, 255, 255, 255, 0] },
    width: 2, height: 1, method: 'area' as const, maxColors: 1,
    palette: { id: 'test', version: '1', source: 'original test', license: 'CC0-1.0', approximate: true,
      colors: [{ id: 'test:solid:red', brand: 'test', series: 'solid', code: 'red', srgb8: [255, 0, 0] as [number, number, number] }] as any },
  };
  const expected = generatePattern(input);
  const browser = await page.evaluate(async request => {
    // Native module path is the actual shipped build, not a mocked Worker.
    const { GenerationWorkerClient } = await import('/src/beadify/worker-client.js');
    const bytes = new Uint8ClampedArray(request.image.data);
    const client = new GenerationWorkerClient();
    const pattern = await client.generate({ ...request, image: { ...request.image, data: bytes } });
    return { pattern, bytes: Array.from(bytes) };
  }, input);
  expect(browser.pattern).toEqual(expected);
  expect(browser.bytes).toEqual(input.image.data);
  const error = await page.evaluate(async request => {
    const { GenerationWorkerClient } = await import('/src/beadify/worker-client.js');
    try {
      await new GenerationWorkerClient().generate({ ...request, image: { ...request.image, data: [300, ...request.image.data.slice(1)] } });
      return null;
    } catch (error) { return String(error); }
  }, input);
  expect(error).toContain('request.image.data[0]');
});

test('cancel clears a queued automatic generation as well as the active Worker', async ({ page }) => {
  let starts = 0;
  await page.route('**/generation.worker.js', async route => {
    starts++;
    // Keep generation active long enough to exercise cancel before the debounce fires.
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.continue().catch(() => {});
  });
  await page.goto('/');
  await page.getByLabel('Generation algorithm').selectOption('area');
  const bytes = await fixture(page);
  await page.getByTestId('generation-file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  const startsAtCancel = starts;
  await page.waitForTimeout(700); // Negative assertion beyond the 420 ms auto-generation deadline.
  expect(starts).toBe(startsAtCancel);
  await expect(page.getByTestId('generation-candidate')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消生成', exact: true })).toHaveCount(0);
});

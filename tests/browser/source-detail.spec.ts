import { assertPatternEquivalent } from '../support/pattern-assertions';
import { test, expect, type Page } from '@playwright/test';
import { createSourceRaster, generatePattern } from '../../src/beadify/core/index';
import { sha256 } from '../../src/beadify/core/hash';
import type { CellConstraint, GenerationRequest } from '../../src/beadify/contracts';

async function draft(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')!));
}
async function upload(page: Page, variant = 0) {
  const bytes = await page.evaluate(async variant => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = variant ? '#aaccee' : '#ffdc35'; ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = '#222222'; ctx.fillRect(4, 12, 23, 1); ctx.fillRect(8, 6, 3, 3); ctx.fillRect(21, 6, 3, 3);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, variant);
  await page.getByTestId('generation-file').setInputFiles({ name: 'source-details.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
}
async function setup(page: Page) {
  await page.goto('/');
  await page.getByLabel('Generation algorithm').selectOption('area');
  await page.getByLabel('Output width', { exact: true }).fill('8');
  await page.getByLabel('Output height', { exact: true }).fill('8');
  await page.getByLabel('Color limit value', { exact: true }).fill('8');
  await upload(page);
}

test('five phase previews persist selected geometry and permit source ROI after reopening without the photo', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await page.getByRole('button', { name: '比较网格位置', exact: true }).click();
  const choices = page.getByRole('group', { name: '网格位置候选', exact: true });
  await expect(choices.getByRole('button')).toHaveCount(5);
  await expect(page.getByRole('progressbar', { name: '图案生成进度', exact: true })).toHaveAttribute('value', '100');
  await choices.getByRole('button', { name: '选择向右网格', exact: true }).click();
  await expect(choices.getByRole('button', { name: '选择向右网格', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  await expect.poll(async () => (await draft(page)).beadify.generationSettings.phase).toEqual([0.35, 0]);
  const saved = await draft(page);
  expect(saved.beadify.sourceRaster.width).toBe(8);
  expect(saved.beadify.sourceRaster.height).toBe(8);
  expect(saved.beadify.sourceRaster.sourceHash).toBe(saved.beadify.generationSettings.sourceHash);
  expect(saved.beadify.sourceRaster.geometry.sourceToGrid[2]).toBeCloseTo(0.35);
  await expect(choices).toHaveCount(0);
  await expect(page.getByTestId('generation-candidate')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('主体原图编辑画布', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('采样网格位置', { exact: true })).toHaveValue('0.35,0');
  const editor = page.getByTestId('constraint-editor'); await editor.locator('summary').first().click();
  await expect(page.getByLabel('重算依据', { exact: true })).toHaveValue('source');
  await page.getByLabel('Selection right', { exact: true }).fill('4');
  await page.getByRole('button', { name: '重算选区', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toContainText('局部重算');
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const result = await draft(page);
  for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) expect(result.cells[y * 8 + x]).toBe(saved.cells[y * 8 + x]);
  expect(result.beadify.sourceRaster).toEqual(saved.beadify.sourceRaster);
});

test('source feature regions keep masks and multiple acceptable colors, undo, and reset for a different image', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  const editor = page.getByTestId('source-feature-editor'); await editor.locator('summary').click();
  await page.getByLabel('原图特征名称', { exact: true }).fill('嘴线');
  await page.getByLabel('原图特征色号', { exact: true }).fill('H2, H7');
  await page.getByLabel('原图特征最少格数', { exact: true }).fill('2');
  await page.getByRole('button', { name: '添加原图特征', exact: true }).click();
  await expect(page.getByLabel('Generation algorithm')).toHaveValue('optimized');
  await expect(editor.locator('li')).toContainText('嘴线 · 至少 2 格');
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '清除原图特征', exact: true }).click();
  await expect(editor.locator('li')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '撤销特征修改', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '撤销特征修改', exact: true }).click();
  await expect(editor.locator('li')).toHaveCount(1);
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const saved = await draft(page), region = saved.beadify.generationSettings.sourceFeatures[0];
  expect(region).toMatchObject({ label: '嘴线', minCells: 2, confidence: 1, importance: 1, allowSingleton: true });
  expect(region.colorIds).toEqual(['MARD:unspecified:H2', 'MARD:unspecified:H7']);
  expect(region.mask.runs).toEqual(Array.from({ length: 32 }, (_, y) => [y * 32, 32]));
  expect(saved.beadify.sourceRaster.features.some((feature: { minCells?: number; colorIds?: string[] }) => feature.minCells === 2 && feature.colorIds?.length === 2)).toBe(true);
  await upload(page, 1);
  await page.getByTestId('source-feature-editor').locator('summary').click();
  await expect(page.getByTestId('source-feature-editor').locator('li')).toHaveCount(0);
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const changed = await draft(page);
  expect(changed.beadify.generationSettings.sourceHash).not.toBe(saved.beadify.generationSettings.sourceHash);
  expect(changed.beadify.generationSettings.sourceFeatures ?? []).toEqual([]);
});

test('phase comparison is cancelled as a group and grid feature rules support accepted colors and minimum counts', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  await page.route('**/generation.worker.js', async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.continue(); });
  await page.getByRole('button', { name: '比较网格位置', exact: true }).click();
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '比较网格位置', exact: true })).toBeEnabled();
  await page.waitForTimeout(700);
  await expect(page.getByRole('group', { name: '网格位置候选', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('generation-candidate')).toHaveCount(0);
  const editor = page.getByTestId('constraint-editor'); await editor.locator('summary').first().click();
  await editor.getByText('细节保留规则', { exact: true }).click();
  await page.getByLabel('选区特征色号', { exact: true }).fill('H2, H7');
  await page.getByLabel('选区特征最少格数', { exact: true }).fill('3');
  await page.getByLabel('选区特征允许单颗', { exact: true }).uncheck();
  await page.getByRole('button', { name: '强化选中色', exact: true }).click();
  const constraints = (await draft(page)).beadify.constraints;
  expect(constraints).toHaveLength(1);
  expect(constraints[0]).toMatchObject({ kind: 'feature', colorIds: ['MARD:unspecified:H2', 'MARD:unspecified:H7'], minCells: 3, allowSingleton: false });
});

test('sampling controls persist explicit choices, leave automatic accurate as mean, and omit unsupported options', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await page.getByText('色卡与重算选项', { exact: true }).click();
  await expect(page.getByLabel('Sampling strategy', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Source edge evidence', { exact: true })).toBeDisabled();
  await page.getByLabel('Generation algorithm').selectOption('optimized');
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByLabel('Pattern style', { exact: true }).selectOption('accurate');
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await expect(page.getByLabel('Sampling strategy', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const automatic = await draft(page);
  expect(automatic.beadify.generationSettings.sampling).toBeUndefined();
  expect(automatic.beadify.sourceRaster.cells.filter(Boolean).every((cell: { samplingStrategy: string }) => cell.samplingStrategy === 'mean')).toBe(true);
  await page.getByLabel('Sampling strategy', { exact: true }).selectOption('weighted-area');
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await expect(page.getByLabel('Source edge evidence', { exact: true })).toBeEnabled();
  await page.getByLabel('Source edge evidence', { exact: true }).uncheck();
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const explicit = await draft(page);
  expect(explicit.beadify.generationSettings.sampling).toEqual({ strategy: 'weighted-area', sourceEdges: false });
  expect(explicit.beadify.sourceRaster.sampling).toEqual({ strategy: 'weighted-area', sourceEdges: false });
  await page.reload();
  await page.getByText('色卡与重算选项', { exact: true }).click();
  await expect(page.getByLabel('Sampling strategy', { exact: true })).toHaveValue('weighted-area');
  await expect(page.getByLabel('Source edge evidence', { exact: true })).not.toBeChecked();
  await page.getByLabel('Generation algorithm').selectOption('nearest');
  await expect(page.getByLabel('Sampling strategy', { exact: true })).toBeDisabled();
  await upload(page);
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  expect((await draft(page)).beadify.generationSettings.sampling).toBeUndefined();
});

test('optimized source features, three restarts, and cached source ROI match Node in the real browser Worker', async ({ page }) => {
  await page.goto('/');
  const palette = { id: 'worker-parity', version: '1', source: 'Original synthetic fixture', license: 'CC0-1.0', approximate: false,
    colors: ([['K', [0, 0, 0]], ['G', [100, 100, 100]], ['Y', [255, 220, 40]], ['W', [255, 255, 255]]] as [string, [number, number, number]][]).map(([id, srgb8]) => ({ id, code: id, brand: 'test', series: 'solid', srgb8 })) };
  const input: GenerationRequest = { schemaVersion: 1, revision: 17, width: 4, height: 4, maxColors: 3, method: 'optimized', style: 'clean', palette,
    image: { width: 8, height: 8, data: Array.from({ length: 64 }, (_, index) => [...(Math.floor(index / 8) === 3 ? [0, 0, 0] : index === 10 ? [255, 255, 255] : [255, 220, 40]), 255]).flat() },
    preprocessing: { crop: [0, 0, 8, 8] }, phase: [0.35, 0], sampling: { strategy: 'modes', sourceEdges: true },
    sourceFeatures: [{ id: 'mouth', label: 'Mouth', mask: { width: 8, height: 8, runs: [[25, 6]] }, colorIds: ['K', 'G'], minCells: 2, importance: 1.5, confidence: 1, allowSingleton: false }],
    requiredColors: ['Y'], optimization: { iterations: 12, maxEvaluations: 5000, restarts: 3, seed: 731 } };
  const sourceHash = sha256(input.image.data), expected = generatePattern(input), raster = createSourceRaster(input, sourceHash);
  expect(expected.diagnostics.optimization?.runs).toHaveLength(3);
  const outside = new Map<string | null, number[]>();
  expected.cells.forEach((id, index) => { if ([5, 6, 9, 10].includes(index)) return; const indices = outside.get(id) ?? []; indices.push(index); outside.set(id, indices); });
  const constraints: CellConstraint[] = [...outside].map(([colorId, cellIndices]) => colorId === null ? { kind: 'lock-empty', cellIndices } : { kind: 'lock-color', colorId, cellIndices });
  const { sourceFeatures: _features, preprocessing: _preprocessing, phase: _phase, sampling: _sampling, ...base } = input;
  const roi: GenerationRequest = { ...base, revision: 18, image: { width: 4, height: 4, data: expected.cells.flatMap(id => id === null ? [0, 0, 0, 0] : [...palette.colors.find(color => color.id === id)!.srgb8, 255]) }, preparedRaster: raster, constraints };
  const expectedRoi = generatePattern(roi);
  const actual = await page.evaluate(async ({ input, sourceHash, roi }) => {
    const { GenerationWorkerClient } = await import('/src/beadify/worker-client.js');
    const client = new GenerationWorkerClient(), data = new Uint8ClampedArray(input.image.data);
    const fresh = await client.generate({ ...input, image: { ...input.image, data } });
    const source = await client.prepareSource({ ...input, image: { ...input.image, data } }, sourceHash);
    const cached = await client.generate({ ...roi, preparedRaster: source });
    return { fresh, source, cached, retainedBytes: Array.from(data) };
  }, { input, sourceHash, roi });
  assertPatternEquivalent(actual.fresh, expected);
  expect(actual.source).toEqual(raster);
  assertPatternEquivalent(actual.cached, expectedRoi);
  expect(actual.retainedBytes).toEqual(input.image.data);
  for (const indices of outside.values()) for (const index of indices) expect(actual.cached.cells[index]).toBe(expected.cells[index]);
});

test('autosave quota omits only source detail and reopening explains why source ROI is unavailable', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page);
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  await expect.poll(async () => Boolean((await draft(page)).beadify?.sourceRaster)).toBe(true);
  const editor = page.getByTestId('constraint-editor'); await editor.locator('summary').first().click();
  await page.getByRole('button', { name: '锁定原色', exact: true }).click();
  await expect.poll(async () => (await draft(page)).beadify.constraints.length).toBeGreaterThan(0);
  const before = await draft(page);
  expect(before.beadify.constraints.every((rule: { kind: string }) => rule.kind === 'lock-color' || rule.kind === 'lock-empty')).toBe(true);
  await expect(page.getByLabel('重算依据', { exact: true })).toHaveValue('source');
  await page.getByRole('button', { name: '重算选区', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toContainText('局部重算');

  // Throw only on the actual autosave carrying the optional source raster.
  // The smaller fallback remains writable, and unrelated localStorage entries
  // keep working. Capture the attempted project to verify no other data loss.
  await page.evaluate(() => {
    const state = window as unknown as { quotaAutosaveAttempts: string[] };
    state.quotaAutosaveAttempts = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
      if (this === localStorage && key === 'perler-beads-generator:draft' && JSON.parse(value).beadify?.sourceRaster) {
        state.quotaAutosaveAttempts.push(value);
        throw new DOMException('Controlled source-detail quota failure', 'QuotaExceededError');
      }
      original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  await expect.poll(async () => (await draft(page)).beadify.sourceRasterOmission).toBe('storage-quota');
  await expect(page.getByText('图纸和编辑已保存。受存储容量限制，原图细节记录未保存；重新打开后可选择原图恢复细节重算。', { exact: true })).toBeVisible();
  const saved = await draft(page);
  expect(saved.cells).toEqual(before.cells);
  expect(saved.beadify.constraints).toEqual(before.beadify.constraints);
  expect(saved.beadify.generationSettings).toEqual(before.beadify.generationSettings);
  expect(saved.layers).toHaveLength(before.layers.length + 1);
  expect(saved.beadify.sourceRaster).toBeUndefined();
  const attempts = await page.evaluate(() => (window as unknown as { quotaAutosaveAttempts: string[] }).quotaAutosaveAttempts.map(value => JSON.parse(value)));
  expect(attempts.length).toBeGreaterThan(0);
  const expectedFallback = attempts.at(-1);
  delete expectedFallback.beadify.sourceRaster;
  expectedFallback.beadify.sourceRasterOmission = 'storage-quota';
  expect(saved).toEqual(expectedFallback);

  await page.reload();
  await expect.poll(async () => (await draft(page)).cells).toEqual(before.cells);
  const restored = await draft(page);
  expect(restored.layers).toEqual(saved.layers);
  expect(restored.beadify.constraints).toEqual(before.beadify.constraints);
  expect(restored.beadify.generationSettings).toEqual(before.beadify.generationSettings);
  expect(restored.beadify.sourceRaster).toBeUndefined();
  expect(restored.beadify.sourceRasterOmission).toBe('storage-quota');
  await page.getByTestId('constraint-editor').locator('summary').first().click();
  const basis = page.getByLabel('重算依据', { exact: true });
  await expect(basis).toHaveValue('pattern');
  await expect(basis.locator('option[value="source"]')).toHaveJSProperty('disabled', true);
  await expect(basis.locator('option[value="pattern"]')).toHaveJSProperty('disabled', false);
  await expect(page.getByText('受保存容量限制，此项目未包含原图细节记录。图纸、图层和规则均已保留；重新选择原图并生成，可恢复原图细节重算。', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

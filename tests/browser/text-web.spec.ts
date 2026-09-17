import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createTextFixtures, textFixtureRequest } from '../../benchmark/text-fixtures';
import { generatePattern, toJsonRequest } from '../../src/beadify/core';
const draft = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')!));
async function setup(page: Page, file = 'disconnected-han') {
  await page.goto('/');
  await page.getByLabel('Generation algorithm').selectOption('optimized');
  await page.getByLabel('Output width', { exact: true }).fill('40');
  await page.getByLabel('Output height', { exact: true }).fill('40');
  await page.getByLabel('Color limit value', { exact: true }).fill('8');
  await page.getByTestId('generation-file').setInputFiles(`benchmark/text/${file}.source.png`);
  await expect(page.getByTestId('generation-candidate')).toBeVisible({ timeout: 30000 });
}
async function importAnalysis(page: Page) {
  await page.getByLabel('Import text analysis', { exact: true }).setInputFiles('benchmark/text/interfaces-v1/disconnected-han.analysis.json');
  await expect(page.getByTestId('text-analysis-status')).toHaveText('分析记录已导入。');
}

test('Web text comparison, accept/undo/redo, record download and project roundtrip', async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await setup(page); await importAnalysis(page);
  await page.getByLabel('Generation algorithm').selectOption('original');
  await expect(page.getByTestId('generation-candidate')).toBeVisible({ timeout: 30000 });
  const before = await draft(page);
  await page.getByRole('button', { name: '比较普通与文字增强', exact: true }).click();
  const choices = page.getByRole('group', { name: '文字增强候选比较', exact: true });
  await expect(choices.getByRole('button')).toHaveCount(2, { timeout: 30000 });
  expect((await draft(page)).cells).toEqual(before.cells);
  await choices.getByRole('button', { name: '普通候选', exact: true }).click();
  await choices.getByRole('button', { name: '文字增强', exact: true }).click();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const accepted = await draft(page);
  expect(accepted.layers).toHaveLength(before.layers.length + 1);
  expect(accepted.beadify.textAnalysis.evidence.length).toBeGreaterThan(0);
  expect(accepted.beadify.generationSettings.method).toBe('optimized');
  await expect(page.getByLabel('Generation algorithm')).toHaveValue('optimized');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await draft(page)).cells).toEqual(before.cells);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await draft(page)).cells).toEqual(accepted.cells);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出文字分析', exact: true }).click();
  const exported = JSON.parse(readFileSync((await (await download).path())!, 'utf8'));
  expect(exported).toEqual(accepted.beadify.textAnalysis);
  await page.getByTestId('project-file').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(accepted)) });
  expect((await draft(page)).beadify.textAnalysis).toEqual(exported);
  await expect(page.getByRole('button', { name: '比较普通与文字增强', exact: true })).toBeDisabled();
  await page.getByTestId('generation-file').setInputFiles('benchmark/text/disconnected-han.source.png');
  await expect(page.getByTestId('generation-candidate')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: '比较普通与文字增强', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'generated/text-web-workbench.png' });
  expect(errors).toEqual([]);
});



test('non-AI deployment supports manual annotations, corrected text and advanced settings', async ({ page }) => {
  test.setTimeout(60000);
  await page.route('**/api/capabilities', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ocr: false, vlm: false }) }));
  await setup(page);
  await expect(page.getByRole('button', { name: '本地识别文字', exact: true })).toHaveCount(0);
  const canvas = page.getByLabel('原图文字区域标注', { exact: true });
  await canvas.scrollIntoViewIfNeeded(); const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2); await page.mouse.up();
  let analysis = (await draft(page)).beadify.textAnalysis;
  expect(analysis.provider.kind).toBe('manual'); expect(analysis.regions).toHaveLength(1);
  const id = analysis.regions[0].id;
  await page.getByLabel(`Correct text ${id}`, { exact: true }).fill('人');
  analysis = (await draft(page)).beadify.textAnalysis;
  expect(analysis.corrections[0].transcription).toBe('人'); expect(analysis.regions[0].transcription).toBe('');
  await page.getByLabel('Text annotation tool').selectOption('ink');
  await canvas.scrollIntoViewIfNeeded(); const maskBox = (await canvas.boundingBox())!;
  await page.mouse.move(maskBox.x + maskBox.width / 2, maskBox.y + maskBox.height / 2); await page.mouse.down(); await page.mouse.move(maskBox.x + maskBox.width / 2 + 10, maskBox.y + maskBox.height / 2); await page.mouse.up();
  expect((await draft(page)).beadify.textAnalysis.evidence[0].origin).toBe('manual');
  await page.getByText('结构优化高级选项', { exact: true }).click();
  await page.getByLabel('Optimization maxEvaluations', { exact: true }).fill('1234');
  await expect(page.getByTestId('generation-candidate')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  expect((await draft(page)).beadify.generationSettings.optimization.maxEvaluations).toBe(1234);
  await page.reload();
  await page.getByText('结构优化高级选项', { exact: true }).click();
  await expect(page.getByLabel('Optimization maxEvaluations', { exact: true })).toHaveValue('1234');
  expect((await draft(page)).beadify.textAnalysis.corrections[0].transcription).toBe('人');
});





test('font retyping changes only its source region and survives the Web candidate transaction', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page); await importAnalysis(page);
  const fixture = createTextFixtures().find(f => f.id === 'disconnected-han')!;
  const request = toJsonRequest(textFixtureRequest(fixture.image, 40));
  const base = generatePattern(request), analysis = JSON.parse(readFileSync('benchmark/text/interfaces-v1/disconnected-han.analysis.json', 'utf8'));
  const rendered = await page.evaluate(async ({ base, analysis, request }) => {
    const { retypeTextPattern } = await import('/src/beadify/text-retype.js');
    const palette = [...base.paletteSnapshot.colors].sort((a, b) => a.srgb8.reduce((s, v) => s + v, 0) - b.srgb8.reduce((s, v) => s + v, 0));
    const layout = { regionId: analysis.regions[0].id, sourceRgbaHash: analysis.source.rgbaHash, text: 'HI', font: 'sans' as const, bold: true, align: 'center' as const, foreground: palette[0].id, background: palette[palette.length - 1].id };
    const first = await retypeTextPattern(base, analysis, layout, request);
    const second = await retypeTextPattern(base, analysis, { ...layout, text: 'AB' }, request);
    return { first, second };
  }, { base, analysis, request });
  expect(rendered.first.inkCells).toBeGreaterThan(0);
  expect(rendered.first.changedCells.length).toBeGreaterThan(0);
  const writable = new Set(rendered.first.writableCells);
  for (let i = 0; i < base.cells.length; i++) if (!writable.has(i)) expect(rendered.first.pattern.cells[i]).toBe(base.cells[i]);
  expect(rendered.first.pattern.cells).not.toEqual(rendered.second.pattern.cells);
  expect(new Set(rendered.first.pattern.cells.filter(Boolean)).size).toBeLessThanOrEqual(request.maxColors);
  await page.getByLabel('Retype content', { exact: true }).fill('HI');
  await page.getByRole('button', { name: '生成重新排字候选', exact: true }).click();
  const choices = page.getByRole('group', { name: '文字增强候选比较', exact: true });
  await expect(choices.getByRole('button')).toHaveCount(3, { timeout: 30000 });
  await expect(page.getByRole('progressbar', { name: '图案生成进度', exact: true })).toHaveAttribute('value', '100');
  await expect(choices.getByRole('button', { name: '重新排字', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const accepted = await draft(page);
  expect(accepted.beadify.textRetype.text).toBe('HI');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await draft(page)).beadify.textRetype).toBeUndefined();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await draft(page)).cells).toEqual(accepted.cells);
  await page.reload();
  expect((await draft(page)).cells).toEqual(accepted.cells);
  await expect(page.getByLabel('Retype content', { exact: true })).toHaveValue('HI');
});


test('default deployment exposes no AI or upload endpoints', async ({ page, request, baseURL }) => {
  expect(await (await request.get('/api/capabilities')).json()).toEqual({ profile: 'lite', ai: false, ocr: false, vlm: false, scene: false });
  for (const endpoint of ['/api/text/ocr', '/api/text/vlm', '/api/scene/analyze']) {
    const response = await request.post(endpoint, { data: { width: 1, height: 1, rgba: 'AAAAAA==' } });
    expect(response.status()).toBe(404);
    expect((await response.json()).code).toBe('AI_DISABLED');
  }
  const external: string[] = [];
  page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== new URL(baseURL!).origin) external.push(r.url()); });
  await page.goto('/');
  await expect(page.getByTestId('lite-profile')).toBeVisible();
  await expect(page.getByTestId('scene-analysis-editor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /本地识别文字|Qwen3/ })).toHaveCount(0);
  const rejected = await page.evaluate(async () => {
    const { requestTextAnalysis } = await import('/src/beadify/text-web.js');
    return requestTextAnalysis('ocr', { width: 1, height: 1, data: [0, 0, 0, 0] }, undefined, new AbortController().signal).then(() => false, () => true);
  });
  expect(rejected).toBe(true);
  expect(external).toEqual([]);
});

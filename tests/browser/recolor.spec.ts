import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProject, withLayers } from '../../src/project';
import type { BeadProject } from '../../src/types';

const source = 'mard-h2', target = 'mard-h7', other = 'mard-h1';
const index = (x: number, y: number) => y * 12 + x;
function fixture() {
  const project = createProject(12, 10);
  const base = project.layers[0];
  for (const [x, y] of [[3, 2], [7, 5], [2, 2], [8, 5]]) base.cells[index(x, y)] = source;
  base.cells[index(5, 4)] = other;
  const upper = { ...base, id: 'upper', cells: Array<string | null>(120).fill(null) };
  upper.cells[index(4, 3)] = source;
  return withLayers(project, [base, upper, { ...upper, id: 'locked', locked: true, cells: upper.cells.slice() },
    { ...upper, id: 'hidden', visible: false, cells: upper.cells.slice() }]);
}
async function draft(page: Page): Promise<BeadProject> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')!));
}
async function open(page: Page, project = fixture()) {
  await page.goto('./');
  await page.getByTestId('project-file').setInputFiles({ name: 'recolor.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await page.getByRole('button', { name: '换色', exact: true }).click();
  await page.getByRole('button', { name: '框选区域', exact: true }).click();
  await page.getByRole('button', { name: '适配', exact: true }).click();
}
async function gridPoint(page: Page, x: number, y: number) {
  const box = (await page.locator('canvas.canvas').boundingBox())!;
  const size = 18 * Math.min(2.4, Math.max(0.12, Math.min((box.width - 88) / (12 * 18), (box.height - 88) / (10 * 18))));
  return { x: box.x + (box.width - 12 * size) / 2 + (x + 0.5) * size,
    y: box.y + (box.height - 10 * size) / 2 + (y + 0.5) * size };
}
async function rectangle(page: Page, from: [number, number], to: [number, number]) {
  const start = await gridPoint(page, ...from), end = await gridPoint(page, ...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
}

test('rectangle recolor protects outside, other colors, holes and locked/hidden layers; undo, redo and save', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const before = await draft(page);
  const apply = page.getByRole('button', { name: '替换选区内同色', exact: true });
  await expect(apply).toBeDisabled();
  // Disconnected source cells on both inclusive corners are selected by a reverse drag.
  await rectangle(page, [7, 5], [3, 2]);
  await expect(page.locator('.recolor-options').getByRole('status')).toHaveText('已框选 5 × 4 格');
  expect((await draft(page)).layers).toEqual(before.layers);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByLabel('原颜色', { exact: true }).selectOption(source);
  await page.getByRole('button', { name: '最近使用 H2', exact: true }).click();
  await expect(apply).toBeDisabled();
  await page.getByRole('button', { name: '最近使用 H7', exact: true }).click();
  await expect(page.getByText('将替换 3 颗拼豆', { exact: true })).toBeVisible();
  await apply.click();
  const after = await draft(page);
  const expected = structuredClone(before.layers);
  expected[0].cells[index(3, 2)] = target;
  expected[0].cells[index(7, 5)] = target;
  expected[1].cells[index(4, 3)] = target;
  expect(after.layers).toEqual(expected);
  await expect(page.getByText('已替换 3 颗同色拼豆。', { exact: true })).toBeVisible();
  await expect(apply).toBeDisabled();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await draft(page)).layers).toEqual(before.layers);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await draft(page)).layers).toEqual(expected);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出编辑', exact: true }).click();
  expect(JSON.parse(await readFile((await (await download).path())!, 'utf8')).layers).toEqual(expected);
  await page.screenshot({ path: 'generated/recolor-selection.png' });
  await page.reload();
  expect((await draft(page)).layers).toEqual(expected);
  expect(errors).toEqual([]);
});

test('empty and one-cell selections, cancelled gesture, clamped bounds and clearing cannot recolor the whole board', async ({ page }) => {
  await open(page);
  const before = await draft(page);
  const apply = page.getByRole('button', { name: '替换选区内同色', exact: true });
  await rectangle(page, [0, 0], [1, 1]);
  await expect(apply).toBeDisabled();
  await expect(page.getByLabel('原颜色', { exact: true })).toBeDisabled();
  await rectangle(page, [3, 2], [3, 2]);
  await expect(page.locator('.recolor-options').getByRole('status')).toHaveText('已框选 1 × 1 格');
  await expect(page.getByText('将替换 1 颗拼豆', { exact: true })).toBeVisible();
  const point = await gridPoint(page, 6, 4);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.locator('canvas.canvas').dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  await expect(page.locator('.recolor-options').getByRole('status')).toHaveText('已框选 1 × 1 格');
  await rectangle(page, [7, 5], [-2, -2]);
  await expect(page.locator('.recolor-options').getByRole('status')).toHaveText('已框选 8 × 6 格');
  await page.getByRole('button', { name: '清除选区', exact: true }).click();
  await expect(apply).toBeDisabled();
  await expect(page.locator('.recolor-options').getByRole('status')).toHaveText('请先在画布拖框选择区域');
  expect((await draft(page)).layers).toEqual(before.layers);
  await rectangle(page, [3, 2], [7, 5]);
  await page.getByRole('button', { name: '画笔', exact: true }).click();
  await page.getByRole('button', { name: '换色', exact: true }).click();
  await expect(apply).toBeDisabled();
  await rectangle(page, [3, 2], [7, 5]);
  // Even importing the same project with the same dimensions clears transient selection.
  await page.getByTestId('project-file').setInputFiles({ name: 'again.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(before)) });
  await expect(apply).toBeDisabled();
  await rectangle(page, [3, 2], [7, 5]);
  await page.getByLabel('Canvas width', { exact: true }).fill('14');
  await page.getByRole('button', { name: '应用', exact: true }).first().click();
  await expect(apply).toBeDisabled();
});

test('whole-pattern recolor still replaces outside the rectangle and active-layer-only visibility is preserved', async ({ page }) => {
  const initial = fixture();
  initial.settings.showActiveLayerOnly = true;
  await open(page, initial);
  await rectangle(page, [3, 2], [7, 5]);
  await expect(page.getByText('将替换 2 颗拼豆', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '替换选区内同色', exact: true }).click();
  const partial = await draft(page);
  expect(partial.layers[1]).toEqual(initial.layers[1]);
  expect(partial.layers.map(layer => layer.visible)).toEqual(initial.layers.map(layer => layer.visible));
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '全部图纸', exact: true }).click();
  const point = await gridPoint(page, 3, 2);
  await page.mouse.click(point.x, point.y);
  const after = await draft(page);
  expect(after.layers[0].cells.filter(cell => cell === source)).toHaveLength(0);
  expect(after.layers[0].cells.filter(cell => cell === target)).toHaveLength(4);
  expect(after.layers.slice(1)).toEqual(initial.layers.slice(1));
});

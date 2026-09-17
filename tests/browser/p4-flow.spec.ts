import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function draft(page: Page) { return page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')!)); }
async function selectRegion(page: Page, rect: [number, number, number, number], width = 16, height = 16) {
  for (const [name, value] of [['left', 0], ['top', 0], ['right', width], ['bottom', height], ['left', rect[0]], ['top', rect[1]], ['right', rect[2]], ['bottom', rect[3]]] as const) {
    await page.getByLabel(`Selection ${name}`, { exact: true }).fill(String(value));
  }
}
async function generateFixture(page: Page) {
  await page.getByLabel('Generation algorithm').selectOption('optimized');
  await page.getByLabel('Output width', { exact: true }).fill('16');
  await page.getByLabel('Output height', { exact: true }).fill('16');
  const limit = page.getByLabel('Color limit', { exact: true });
  await limit.press('Home');
  for (let i = 1; i < 8; i++) await limit.press('ArrowRight');
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 32, 32);
    context.fillStyle = '#ffdc35'; context.fillRect(6, 6, 20, 20);
    context.fillStyle = '#222222'; context.fillRect(10, 11, 3, 3); context.fillRect(19, 11, 3, 3); context.fillRect(13, 20, 7, 2);
    context.fillStyle = '#ffffff'; context.fillRect(11, 11, 1, 1); context.fillRect(20, 11, 1, 1);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByTestId('generation-file').setInputFiles({ name: 'original-face.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByLabel('主体背景', { exact: true }).selectOption('edge');
  for (const [name, value] of [['左', 2], ['上', 2], ['右', 30], ['下', 30]] as const) {
    const input = page.getByLabel(`主体裁切${name}`, { exact: true });
    await input.fill(String(value)); await input.press('Enter');
  }
  await page.getByRole('button', { name: '保留画笔', exact: true }).click();
  await page.getByLabel('主体画笔大小', { exact: true }).press('Home');
  const sourceCanvas = page.getByLabel('主体原图编辑画布', { exact: true });
  await sourceCanvas.scrollIntoViewIfNeeded();
  const sourceBox = (await sourceCanvas.boundingBox())!;
  await page.mouse.click(sourceBox.x + sourceBox.width * 10.5 / 32, sourceBox.y + sourceBox.height * 10.5 / 32);
  await expect(page.getByRole('button', { name: '生成预览', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toHaveCount(0);
  await expect.poll(async () => (await draft(page)).beadify.generationSettings.preprocessing).toMatchObject({ crop: [2, 2, 30, 30], background: 'edge' });
  const preprocessing = (await draft(page)).beadify.generationSettings.preprocessing;
  expect(preprocessing.mask).toHaveLength(32 * 32);
  expect(preprocessing.mask.some((value: number) => value === 1)).toBe(true);
}

test('user can crop, optimize, constrain, recalculate, undo, save and reopen without the original', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await generateFixture(page);
  const generated = await draft(page);
  expect(generated.width).toBe(16); expect(generated.height).toBe(16);
  expect(generated.cells.some((cell: unknown) => cell === null)).toBe(true);
  expect(generated.cells.some(Boolean)).toBe(true);
  await page.getByTestId('constraint-editor').locator('summary').click();
  const selection = page.getByLabel('Constraint selection', { exact: true });
  await selection.scrollIntoViewIfNeeded();
  const box = (await selection.boundingBox())!;
  await page.mouse.move(box.x + box.width * 4.2 / 16, box.y + box.height * 4.2 / 16);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 5.2 / 16, box.y + box.height * 5.2 / 16, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByLabel('Selection left', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Selection right', { exact: true })).toHaveValue('6');
  await page.getByRole('button', { name: '锁定原色', exact: true }).click();
  await selectRegion(page, [6, 4, 8, 6]);
  await page.getByRole('button', { name: '保护细节', exact: true }).click();
  await selectRegion(page, [4, 8, 12, 12]);
  await page.getByRole('button', { name: '简化色块', exact: true }).click();
  const annotated = await draft(page);
  expect(annotated.beadify.constraints.some((constraint: { kind: string }) => constraint.kind === 'lock-color')).toBe(true);
  expect(annotated.beadify.constraints.some((constraint: { kind: string }) => constraint.kind === 'protect')).toBe(true);
  expect(annotated.beadify.constraints.some((constraint: { kind: string }) => constraint.kind === 'simplify')).toBe(true);
  await selectRegion(page, [2, 2, 14, 14]);
  await page.getByRole('button', { name: '重算选区', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toContainText('局部重算');
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const accepted = await draft(page);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (x < 2 || x >= 14 || y < 2 || y >= 14) expect(accepted.cells[y * 16 + x]).toBe(annotated.cells[y * 16 + x]);
  }
  for (const constraint of annotated.beadify.constraints) if (constraint.kind === 'lock-color' || constraint.kind === 'lock-empty') {
    for (const index of constraint.cellIndices) expect(accepted.cells[index]).toBe(annotated.cells[index]);
  }
  expect(accepted.beadify.constraints).toEqual(annotated.beadify.constraints);
  expect(accepted.beadify.generationSettings).toEqual(annotated.beadify.generationSettings);
  expect(accepted.beadify.generationSettings.sourceName).toBe('original-face.png');
  expect(accepted.beadify.generationSettings.preprocessing.mask).toEqual(annotated.beadify.generationSettings.preprocessing.mask);
  expect(accepted.layers).toHaveLength(annotated.layers.length + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const undone = await draft(page);
  expect(undone.cells).toEqual(annotated.cells);
  expect(undone.beadify).toEqual(annotated.beadify);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await draft(page)).cells).toEqual(accepted.cells);
  expect((await draft(page)).beadify).toEqual(accepted.beadify);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出编辑', exact: true }).click();
  const download = await downloadPromise, savedBytes = await readFile((await download.path())!), saved = JSON.parse(savedBytes.toString());
  expect(saved.beadify.generationSettings).toEqual(annotated.beadify.generationSettings);
  expect(saved.beadify.constraints).toEqual(annotated.beadify.constraints);
  await page.getByTestId('project-file').setInputFiles({ name: 'saved-project.json', mimeType: 'application/json', buffer: savedBytes });
  await expect(page.getByLabel('主体原图编辑画布', { exact: true })).toHaveCount(0);
  expect((await draft(page)).beadify).toEqual(saved.beadify);
  await page.reload();
  expect((await draft(page)).beadify).toEqual(saved.beadify);
  await expect(page.getByRole('button', { name: '生成预览', exact: true })).toBeDisabled();
  await page.getByTestId('constraint-editor').locator('summary').click();
  await selectRegion(page, [2, 2, 14, 14]);
  await page.getByRole('button', { name: '重算选区', exact: true }).click();
  await expect(page.getByTestId('generation-candidate')).toContainText('局部重算');
  expect((await draft(page)).cells).toEqual(saved.cells);
  await page.getByRole('button', { name: '拒绝候选', exact: true }).click();
  // A different image with the same filename must not inherit a saved crop/mask.
  const replacement = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    c.getContext('2d')!.fillRect(0, 0, 32, 32);
    const blob = await new Promise<Blob>(resolve => c.toBlob(value => resolve(value!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByTestId('generation-file').setInputFiles({ name: 'original-face.png', mimeType: 'image/png', buffer: Buffer.from(replacement) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const replaced = await draft(page);
  expect(replaced.beadify.generationSettings.preprocessing).toEqual({});
  expect(replaced.beadify.generationSettings.sourceHash).not.toBe(saved.beadify.generationSettings.sourceHash);
  expect(errors).toEqual([]);
});

test('imported palette snapshot drives both the main canvas and the preview PNG', async ({ page }) => {
  await page.goto('/');
  const json = await page.evaluate(async () => {
    const { createProject, withLayers, projectWithSnapshot, serializeProject } = await import('/src/project.js');
    let project = createProject(2, 1, 'Saved RGB');
    project = projectWithSnapshot(withLayers(project, [{ ...project.layers[0], cells: ['mard-h7', 'mard-h2'] }]));
    project.beadify!.paletteSnapshot.colors.find((color: { code: string }) => color.code === 'H7')!.srgb8 = [17, 91, 203];
    project.settings = { ...project.settings, beadDisplayMode: 'pixel', showGrid: false, showCoordinates: false, showPegboardBoundaries: false, showColorCodes: false };
    return serializeProject(project);
  });
  await page.getByTestId('project-file').setInputFiles({ name: 'saved-rgb.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  const canvas = page.locator('canvas.canvas');
  await expect.poll(async () => canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 17 && pixels[i + 1] === 91 && pixels[i + 2] === 203) count++;
    return count;
  })).toBeGreaterThan(100);
  await page.getByRole('button', { name: '导出图纸', exact: true }).click();
  await page.getByRole('combobox', { name: '导出格式', exact: true }).selectOption('preview');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PREVIEW', exact: true }).click();
  const bytes = await readFile((await (await downloadPromise).path())!);
  const first = await page.evaluate(async data => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    return Array.from(context.getImageData(8, 8, 1, 1).data);
  }, [...bytes]);
  expect(first).toEqual([17, 91, 203, 255]);
});

test('accepting a basic-palette candidate preserves hidden full-palette RGB when saved', async ({ page }) => {
  await page.goto('/');
  const json = await page.evaluate(async () => {
    const { createProject, withLayers, projectWithSnapshot, serializeProject } = await import('/src/project.js');
    let project = createProject(1, 1, 'Hidden P1');
    project = projectWithSnapshot(withLayers(project, [{ ...project.layers[0], cells: ['mard-p1'] }]));
    project.beadify!.paletteSnapshot.colors.find((color: { code: string }) => color.code === 'P1')!.srgb8 = [17, 91, 203];
    return serializeProject(project);
  });
  await page.getByTestId('project-file').setInputFiles({ name: 'hidden-p1.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await page.getByLabel('Generation algorithm').selectOption('nearest');
  await page.getByLabel('Output width', { exact: true }).fill('8');
  await page.getByLabel('Output height', { exact: true }).fill('8');
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    const context = canvas.getContext('2d')!; context.fillStyle = '#222222'; context.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByTestId('generation-file').setInputFiles({ name: 'new-basic-pattern.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const accepted = await draft(page);
  expect(accepted.layers.some((layer: { visible: boolean; cells: Array<string | null> }) => !layer.visible && layer.cells.includes('mard-p1'))).toBe(true);
  expect(accepted.beadify.paletteSnapshot.colors.find((color: { code: string }) => color.code === 'P1').srgb8).toEqual([17, 91, 203]);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出编辑', exact: true }).click();
  const download = await downloadPromise, saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(saved.beadify.paletteSnapshot.colors.find((color: { code: string }) => color.code === 'P1').srgb8).toEqual([17, 91, 203]);
  await page.reload();
  expect((await draft(page)).beadify.paletteSnapshot.colors.find((color: { code: string }) => color.code === 'P1').srgb8).toEqual([17, 91, 203]);
});

test('smaller candidates retain hidden and zero-opacity layer cells through undo and saving', async ({ page }) => {
  await page.goto('/');
  const json = await page.evaluate(async () => {
    const { createProject, createLayer, withLayers, serializeProject } = await import('/src/project.js');
    const project = createProject(16, 16, 'Invisible work at the edges');
    const hidden = { ...project.layers[0], visible: false, cells: project.cells.slice() };
    hidden.cells[255] = 'mard-h7';
    const transparent = { ...createLayer(16, 16, 'Zero opacity'), opacity: 0 };
    transparent.cells[239] = 'mard-h2';
    return serializeProject(withLayers(project, [hidden, transparent]));
  });
  await page.getByTestId('project-file').setInputFiles({ name: 'invisible-work.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  const original = await draft(page);
  expect(original.cells.every((cell: unknown) => cell === null)).toBe(true);
  await page.getByLabel('Generation algorithm').selectOption('nearest');
  await page.getByLabel('Output width', { exact: true }).fill('8');
  await page.getByLabel('Output height', { exact: true }).fill('8');
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    canvas.getContext('2d')!.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByTestId('generation-file').setInputFiles({ name: 'smaller.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const accepted = await draft(page);
  expect([accepted.width, accepted.height]).toEqual([16, 16]);
  expect(accepted.layers.slice(0, 2).map((layer: { cells: unknown[] }) => layer.cells)).toEqual(original.layers.map((layer: { cells: unknown[] }) => layer.cells));
  expect(accepted.layers.slice(0, 2).every((layer: { visible: boolean }) => !layer.visible)).toBe(true);
  expect(accepted.cells.filter(Boolean)).toHaveLength(64);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await draft(page)).layers).toEqual(original.layers);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await draft(page)).layers).toEqual(accepted.layers);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出编辑', exact: true }).click();
  const saved = JSON.parse(await readFile((await (await downloadPromise).path())!, 'utf8'));
  expect(saved.layers).toEqual(accepted.layers);
  await page.reload();
  expect((await draft(page)).layers).toEqual(accepted.layers);
});

test('feature constraints capture newly selected colors in a narrow saved palette', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const json = await page.evaluate(async () => {
    const { createProject, withLayers, serializeProject } = await import('/src/project.js');
    const project = createProject(8, 8, 'One-color snapshot');
    return serializeProject(withLayers(project, [{ ...project.layers[0], cells: project.cells.map(() => 'mard-h7') }]));
  });
  await page.getByTestId('project-file').setInputFiles({ name: 'one-color.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  const original = await draft(page);
  expect(original.beadify.paletteSnapshot.colors.map((color: { code: string }) => color.code)).toEqual(['H7']);
  await page.locator('.palette-grid').getByRole('button', { name: 'H2', exact: true }).click();
  await page.getByTestId('constraint-editor').locator('summary').click();
  await page.getByRole('button', { name: '强化选中色', exact: true }).click();
  await expect.poll(async () => (await draft(page)).beadify.constraints).toEqual([
    { kind: 'feature', cellIndices: Array.from({ length: 64 }, (_, index) => index), colorId: 'MARD:unspecified:H2', strength: 1 },
  ]);
  const annotated = await draft(page);
  expect(annotated.beadify.paletteSnapshot.colors.some((color: { code: string }) => color.code === 'H2')).toBe(true);
  expect(annotated.cells).toEqual(original.cells);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await draft(page)).beadify).toEqual(original.beadify);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await draft(page)).beadify).toEqual(annotated.beadify);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出编辑', exact: true }).click();
  const bytes = await readFile((await (await downloadPromise).path())!);
  expect(JSON.parse(bytes.toString()).beadify).toEqual(annotated.beadify);
  await page.getByTestId('project-file').setInputFiles({ name: 'feature.json', mimeType: 'application/json', buffer: bytes });
  await page.reload();
  expect((await draft(page)).beadify).toEqual(annotated.beadify);
  expect(errors).toEqual([]);
});

test('import and reload preserve a large allowed-color subset when generating again', async ({ page }) => {
  await page.goto('/');
  const json = await page.evaluate(async () => {
    const { createProject, serializeProject } = await import('/src/project.js');
    const { workspacePalette } = await import('/src/beadify/adapter.js');
    const { completePalette } = await import('/src/palette.js');
    const project = createProject(8, 8, 'All colors except H7');
    const palette = workspacePalette(completePalette);
    project.beadify = {
      schemaVersion: 1, paletteSnapshot: palette,
      lastGeneration: { method: 'nearest', inputRevision: 0, configHash: null },
      generationSettings: { method: 'nearest', width: 8, height: 8, maxColors: 2,
        allowedColors: palette.colors.filter((color: { code: string }) => color.code !== 'H7').map((color: { id: string }) => color.id) },
    };
    return serializeProject(project);
  });
  const allowed = JSON.parse(json).beadify.generationSettings.allowedColors;
  expect(allowed).toHaveLength(290);
  await page.getByTestId('project-file').setInputFiles({ name: 'allowed-subset.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(page.getByLabel('Allowed colors', { exact: true })).toHaveValue(allowed.join(', '));
  await page.reload();
  await expect(page.getByLabel('Allowed colors', { exact: true })).toHaveValue(allowed.join(', '));
  const bytes = await page.evaluate(async () => {
    const { getColor } = await import('/src/palette.js');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    const context = canvas.getContext('2d')!;
    context.fillStyle = getColor('mard-h7')!.hex; context.fillRect(0, 0, 2, 2);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByTestId('generation-file').setInputFiles({ name: 'excluded-h7.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
  const generated = await draft(page);
  expect(generated.beadify.generationSettings.allowedColors).toEqual(allowed);
  expect(generated.cells.filter(Boolean)).toHaveLength(64);
  expect(generated.cells).not.toContain('mard-h7');
});

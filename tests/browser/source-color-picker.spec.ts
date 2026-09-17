import { expect, test, type Locator, type Page } from '@playwright/test';
import { basicPalette, completePalette } from '../../src/palette';
import { createProject, projectWithSnapshot } from '../../src/project';

test.use({ hasTouch: true });

const openPicker = (page: Page) => page.getByRole('button', { name: '从原图取色', exact: true }).click();
const dialog = (page: Page) => page.getByRole('dialog', { name: '从原图取色', exact: true });
const sampleCanvas = (page: Page) => dialog(page).getByRole('img', { name: '原图取色画布' });
const draft = (page: Page) => page.evaluate(() => localStorage.getItem('perler-beads-generator:draft'));

async function imageFile(page: Page, name: string, rgba: number[][]) {
  const bytes = await page.evaluate(async rgba => {
    const canvas = document.createElement('canvas'); canvas.width = rgba.length; canvas.height = 1;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.flat()), rgba.length, 1), 0, 0);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, rgba);
  return { name, mimeType: 'image/png', buffer: Buffer.from(bytes) };
}

async function pickPixel(page: Page, canvas: Locator, x: number, width: number) {
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + (x + .5) * box.width / width, box.y + box.height / 2);
}

test('source popup samples original pixels and selecting a match updates current/recent colors without editing the project', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Generation algorithm', { exact: true }).selectOption('area');
  await page.getByLabel('Output width', { exact: true }).fill('12');
  await page.getByTestId('generation-file').setInputFiles(await imageFile(page, 'original.png', [[18, 87, 143, 255], [...basicPalette[0].rgb, 255]]));
  await expect(page.getByTestId('generation-candidate')).toBeVisible();
  await page.getByTestId('reference-file').setInputFiles(await imageFile(page, 'other-reference.png', [[255, 0, 0, 255]]));
  const before = await draft(page);
  await openPicker(page);
  await expect(sampleCanvas(page)).toBeVisible();
  await pickPixel(page, sampleCanvas(page), 0, 2);
  await expect(dialog(page).locator('.source-color-reference strong')).toHaveText('#12578F');
  await expect(dialog(page).locator('.source-color-candidates button')).toHaveCount(6);
  await dialog(page).getByRole('button', { name: '参考图', exact: true }).click();
  await expect(sampleCanvas(page)).toHaveAttribute('width', '1');
  await expect(dialog(page).locator('.source-color-candidates button')).toHaveCount(0);
  await sampleCanvas(page).click();
  await expect(dialog(page).locator('.source-color-reference strong')).toHaveText('#FF0000');
  await dialog(page).getByRole('button', { name: '生成原图', exact: true }).click();
  await expect(sampleCanvas(page)).toHaveAttribute('width', '2');
  await pickPixel(page, sampleCanvas(page), 1, 2);
  await expect(dialog(page).locator('.source-color-candidates button').first()).toHaveAccessibleName('使用 A1');
  await page.screenshot({ path: 'generated/source-color-picker.png' });
  await dialog(page).getByRole('button', { name: '使用 A1', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.palette-selected-main strong')).toHaveText('A1');
  await expect(page.locator('.recent-color-row button').first()).toHaveAccessibleName('最近使用 A1');
  await expect(page.getByRole('button', { name: '从原图取色', exact: true })).toBeFocused();
  expect(await draft(page)).toBe(before);
  expect(errors).toEqual([]);
});

test('standalone image picking supports transparency, keyboard, zoom and cancellation while preserving recolor mode', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '换色', exact: true }).click();
  await page.getByRole('button', { name: '框选区域', exact: true }).click();
  const before = await draft(page);
  await openPicker(page);
  await expect(dialog(page)).toContainText('选择一张图片开始取色');
  await dialog(page).getByLabel('取色图片文件').setInputFiles(await imageFile(page, 'alpha.png', [[255, 0, 0, 0], [0, 0, 0, 128], [...basicPalette[0].rgb, 255]]));
  await expect(sampleCanvas(page)).toBeVisible();
  await pickPixel(page, sampleCanvas(page), 1, 3);
  await expect(dialog(page).locator('.source-color-reference strong')).toHaveText('#7F7F7F');
  await expect(dialog(page)).toContainText('半透明像素按白底显示色匹配');
  await sampleCanvas(page).press('ArrowLeft');
  await expect(dialog(page)).toContainText('这里是透明区域');
  await expect(dialog(page).locator('.source-color-candidates button')).toHaveCount(0);
  await sampleCanvas(page).press('ArrowRight');
  await sampleCanvas(page).press('ArrowRight');
  await expect(dialog(page).locator('.source-color-candidates button').first()).toHaveAccessibleName('使用 A1');
  const canvas = sampleCanvas(page);
  const initialWidth = (await canvas.boundingBox())!.width;
  await dialog(page).getByLabel('取色图片缩放').fill('3');
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeCloseTo(initialWidth * 3, 0);
  await dialog(page).locator('.source-color-viewport').evaluate(element => { element.scrollLeft = element.scrollWidth; element.scrollTop = element.scrollHeight / 2; });
  // Click the visible last pixel after zooming and scrolling, not a scaled canvas screenshot.
  const viewport = (await dialog(page).locator('.source-color-viewport').boundingBox())!;
  await page.mouse.click(viewport.x + viewport.width - 30, viewport.y + viewport.height / 2);
  await expect(dialog(page).locator('.source-color-reference strong')).toHaveText(basicPalette[0].hex.toUpperCase());
  await dialog(page).getByRole('button', { name: '使用 A1', exact: true }).click();
  await expect(page.getByRole('button', { name: '框选区域', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.recolor-target')).toContainText('A1');
  expect(await draft(page)).toBe(before);
  await openPicker(page);
  await expect(sampleCanvas(page)).toBeVisible();
  await expect(dialog(page)).toContainText('alpha.png');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.palette-selected-main strong')).toHaveText('A1');
  expect(await draft(page)).toBe(before);
});

test('reference-only picking handles load failures and uses saved palette colors and the active palette mode', async ({ page }) => {
  await page.goto('/');
  const project = projectWithSnapshot(createProject(12, 10));
  const saved = project.beadify!.paletteSnapshot.colors.find(color => color.code === 'A1')!;
  saved.srgb8 = [1, 2, 3];
  await page.getByTestId('project-file').setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  const fullOnly = completePalette.find(color => !basicPalette.some(basic => basic.id === color.id))!;
  await page.getByTestId('reference-file').setInputFiles(await imageFile(page, 'reference.png', [[1, 2, 3, 255], [...fullOnly.rgb, 255]]));
  const before = await draft(page);
  await openPicker(page);
  await expect(sampleCanvas(page)).toBeVisible();
  await pickPixel(page, sampleCanvas(page), 0, 2);
  await expect(dialog(page).locator('.source-color-candidates button').first()).toHaveAccessibleName('使用 A1');
  await expect(dialog(page).locator('.source-color-candidates button').first()).toContainText('#010203');
  await pickPixel(page, sampleCanvas(page), 1, 2);
  await expect(dialog(page).getByRole('button', { name: `使用 ${fullOnly.primaryCode}`, exact: true })).toHaveCount(0);
  await dialog(page).getByLabel('取色图片文件').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await expect(dialog(page).locator('.source-color-candidates button')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: '参考图', exact: true }).click();
  await expect(sampleCanvas(page)).toBeVisible();
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByLabel('Palette mode', { exact: true }).selectOption('complete');
  await openPicker(page);
  await expect(sampleCanvas(page)).toBeVisible();
  await pickPixel(page, sampleCanvas(page), 1, 2);
  await expect(dialog(page).locator('.source-color-candidates button').first()).toHaveAccessibleName(`使用 ${fullOnly.primaryCode}`);
  expect(await draft(page)).toBe(before);
});

test('narrow viewport keeps sampling and color choices accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await openPicker(page);
  await dialog(page).getByLabel('取色图片文件').setInputFiles(await imageFile(page, 'mobile.png', [[...basicPalette[0].rgb, 255]]));
  await expect(sampleCanvas(page)).toBeVisible();
  await sampleCanvas(page).tap();
  await expect(dialog(page).locator('.source-color-candidates button')).toHaveCount(6);
  const bounds = (await dialog(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'generated/source-color-picker-mobile.png' });
  await dialog(page).getByRole('button', { name: '使用 A1', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
});

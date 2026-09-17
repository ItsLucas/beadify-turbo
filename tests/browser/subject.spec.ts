import { expect, test } from '@playwright/test';

async function mountSubject(page: any) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { default: SubjectEditor } = await import('/src/beadify/SubjectEditor.js');
    const source = document.createElement('canvas'); source.width = 100; source.height = 50;
    const context = source.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 100, 50);
    context.fillStyle = '#000000'; context.fillRect(25, 10, 20, 20);
    context.fillStyle = '#ffffff'; context.fillRect(32, 16, 6, 6);
    const image = { width: 100, height: 50, data: context.getImageData(0, 0, 100, 50).data };
    const original = Array.from(image.data);
    const host = document.createElement('div'); host.id = 'subject-harness';
    Object.assign(host.style, { position: 'fixed', inset: '20px', zIndex: '99999', padding: '20px', background: '#fff', overflow: 'auto' });
    document.body.append(host);
    function Harness() {
      const [value, setValue] = React.useState({});
      (window as any).subjectTest = { value, original, image };
      return React.createElement(SubjectEditor, { image, value, onChange: setValue });
    }
    ReactDOM.createRoot(host).render(React.createElement(Harness));
  });
  await expect(page.locator('#subject-harness').getByLabel('主体原图编辑画布')).toBeVisible();
  return page.locator('#subject-harness');
}
async function atPixel(page: any, canvas: any, x: number, y: number, action: 'click' | 'move' = 'click') {
  const box = await canvas.boundingBox();
  const point = { x: box.x + (x + 0.5) * box.width / 100, y: box.y + (y + 0.5) * box.height / 50 };
  if (action === 'click') await page.mouse.click(point.x, point.y);
  else await page.mouse.move(point.x, point.y);
}
async function alphaAt(canvas: any, x: number, y: number) {
  return canvas.evaluate((element: HTMLCanvasElement, point: [number, number]) => element.getContext('2d')!.getImageData(point[0], point[1], 1, 1).data[3], [x, y]);
}

test('subject editor preserves enclosed highlights, supports correction strokes and undo without modifying source pixels', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const editor = await mountSubject(page);
  const source = editor.getByLabel('主体原图编辑画布'), preview = editor.getByLabel('透明主体预览');
  const box = await source.boundingBox();
  expect(box!.width / box!.height).toBeCloseTo(2, 3);
  await editor.getByLabel('主体背景', { exact: true }).selectOption('edge');
  await expect.poll(() => alphaAt(preview, 0, 0)).toBe(0);
  expect(await alphaAt(preview, 34, 18)).toBe(255);
  await editor.getByRole('button', { name: '删除画笔', exact: true }).click();
  await editor.getByLabel('主体画笔大小', { exact: true }).focus();
  await editor.getByLabel('主体画笔大小', { exact: true }).press('Home');
  await atPixel(page, source, 34, 18);
  await expect.poll(() => alphaAt(preview, 34, 18)).toBe(0);
  await editor.getByRole('button', { name: '保留画笔', exact: true }).click();
  await atPixel(page, source, 5, 5);
  await expect.poll(() => alphaAt(preview, 5, 5)).toBe(255);
  await editor.getByRole('button', { name: '撤销主体修改', exact: true }).click();
  await expect.poll(() => alphaAt(preview, 5, 5)).toBe(0);
  expect(await alphaAt(preview, 34, 18)).toBe(0);
  await editor.getByRole('button', { name: '撤销主体修改', exact: true }).click();
  await expect.poll(() => alphaAt(preview, 34, 18)).toBe(255);
  const unchanged = await page.evaluate(() => {
    const { original, image } = (window as any).subjectTest;
    return original.every((byte: number, index: number) => byte === image.data[index]);
  });
  expect(unchanged).toBe(true);
  await editor.getByRole('button', { name: '重置主体', exact: true }).click();
  await expect.poll(() => alphaAt(preview, 0, 0)).toBe(255);
  expect(errors).toEqual([]);
});

test('subject crop drag and numeric bounds agree with pixel coordinates and can be undone', async ({ page }) => {
  const editor = await mountSubject(page), source = editor.getByLabel('主体原图编辑画布');
  await atPixel(page, source, 20, 5, 'move'); await page.mouse.down();
  await atPixel(page, source, 75, 45, 'move'); await page.mouse.up();
  await expect(editor.getByLabel('主体裁切左', { exact: true })).toHaveValue('20');
  await expect(editor.getByLabel('主体裁切上', { exact: true })).toHaveValue('5');
  await expect(editor.getByLabel('主体裁切右', { exact: true })).toHaveValue('76');
  await expect(editor.getByLabel('主体裁切下', { exact: true })).toHaveValue('46');
  await expect(editor.getByLabel('透明主体预览')).toHaveAttribute('width', '56');
  await expect(editor.getByLabel('透明主体预览')).toHaveAttribute('height', '41');
  await editor.getByLabel('主体裁切右', { exact: true }).fill('70');
  await editor.getByLabel('主体裁切右', { exact: true }).press('Enter');
  await expect(editor.getByLabel('透明主体预览')).toHaveAttribute('width', '50');
  await editor.getByLabel('主体裁切左', { exact: true }).fill('80');
  await editor.getByLabel('主体裁切左', { exact: true }).press('Enter');
  await expect(editor.getByRole('alert')).toContainText('裁切范围需在原图内');
  await expect(editor.getByLabel('主体裁切左', { exact: true })).toHaveValue('20');
  await editor.getByRole('button', { name: '撤销主体修改', exact: true }).click();
  await expect(editor.getByLabel('透明主体预览')).toHaveAttribute('width', '56');
  await editor.getByRole('button', { name: '撤销主体修改', exact: true }).click();
  await expect(editor.getByLabel('透明主体预览')).toHaveAttribute('width', '100');
  await expect(editor.getByLabel('透明主体预览')).toHaveAttribute('height', '50');
});

test('white-border action crops the exterior rectangle while preserving background mode, highlights and undo', async ({ page }) => {
  const editor = await mountSubject(page);
  await editor.getByRole('button', { name: '裁切白色边框', exact: true }).click();
  await expect(editor.getByLabel('主体裁切左', { exact: true })).toHaveValue('25');
  await expect(editor.getByLabel('主体裁切上', { exact: true })).toHaveValue('10');
  await expect(editor.getByLabel('主体裁切右', { exact: true })).toHaveValue('45');
  await expect(editor.getByLabel('主体裁切下', { exact: true })).toHaveValue('30');
  await expect(editor.getByLabel('主体背景', { exact: true })).toHaveValue('keep');
  const preview = editor.getByLabel('透明主体预览');
  expect(await alphaAt(preview, 9, 8)).toBe(255);
  const white = await preview.evaluate((canvas: HTMLCanvasElement) => [...canvas.getContext('2d')!.getImageData(9, 8, 1, 1).data]);
  expect(white).toEqual([255, 255, 255, 255]);
  await editor.getByRole('button', { name: '撤销主体修改', exact: true }).click();
  await expect(preview).toHaveAttribute('width', '100');
  await expect(preview).toHaveAttribute('height', '50');
});

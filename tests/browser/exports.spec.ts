import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Exercise the shipped native modules and browser canvas encoder, without private artwork.
async function prepare(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { createProject, createLayer, withLayers } = await import('/src/project.js');
    const base = createProject(40, 2, 'Export fixture');
    const cells = Array(80).fill(null); cells[0] = 'mard-h7'; cells[1] = 'mard-h2'; cells[39] = 'mard-a1';
    const overlay = Array(80).fill(null); overlay[0] = 'mard-a1';
    const hidden = Array(80).fill('mard-a2');
    (window as any).__exportProject = withLayers(base, [
      { ...base.layers[0], cells, includeInUsage: false },
      { ...createLayer(40, 2, 'Overlay'), cells: overlay },
      { ...createLayer(40, 2, 'Hidden'), visible: false, cells: hidden },
    ]);
  });
}

test('browser renders a true numbered SVG and clean transparent PNG from visible layers', async ({ page }) => {
  await prepare(page);
  const result = await page.evaluate(async () => {
    const { renderPatternSvg, svgCanvas, previewCanvas, visibleBom } = await import('/src/beadify/export.js');
    const { projectColor } = await import('/src/project.js');
    const project = (window as any).__exportProject;
    const options = { exportBounds: 'canvas', showColorCodes: true, showGuideLines: true };
    const svg = renderPatternSvg(project, options), doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const preview = previewCanvas(project, options), context = preview.getContext('2d')!;
    const mirrored = previewCanvas(project, { ...options, mirror: true });
    const print = await svgCanvas(svg);
    const printBlob = await new Promise<Blob>(resolve => print.toBlob(blob => resolve(blob!)));
    return {
      parserError: doc.querySelector('parsererror')?.textContent, beads: doc.querySelectorAll('[data-bead]').length,
      legend: Array.from(doc.querySelectorAll('[data-legend]')).map(element => element.textContent),
      bom: visibleBom(project), first: Array.from(context.getImageData(8, 8, 1, 1).data),
      transparent: Array.from(context.getImageData(40, 24, 1, 1).data),
      mirrored: Array.from(mirrored.getContext('2d')!.getImageData(8, 8, 1, 1).data),
      expected: projectColor(project, 'mard-a1')!.rgb, printBytes: printBlob.size,
    };
  });
  expect(result.parserError).toBeUndefined();
  expect(result.beads).toBe(3); expect(result.bom.totalBeads).toBe(3);
  expect(result.legend).toContain('A1 × 2'); expect(result.legend).toContain('H2 × 1');
  expect(result.first).toEqual([...result.expected, 255]); expect(result.mirrored).toEqual([...result.expected, 255]);
  expect(result.transparent).toEqual([0, 0, 0, 0]); expect(result.printBytes).toBeGreaterThan(1000);
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(async () => {
    const { downloadPreviewPng } = await import('/src/exporters.js');
    await downloadPreviewPng((window as any).__exportProject, { exportBounds: 'canvas', showColorCodes: false, showGuideLines: false });
  });
  const download = await downloadPromise, png = await readFile((await download.path())!);
  expect(download.suggestedFilename()).toMatch(/-preview\.png$/);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(640); expect(png.readUInt32BE(20)).toBe(32);
});

test('browser PDF export contains actual A4 pattern pages and one global legend', async ({ page }) => {
  await prepare(page);
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(async () => {
    const { downloadPrintPdf } = await import('/src/exporters.js');
    await downloadPrintPdf((window as any).__exportProject, { exportBounds: 'canvas', showColorCodes: true, showGuideLines: true, paperSize: 'a4', pitchMm: 5, mirror: true, overlapCells: 1 });
  });
  const download = await downloadPromise, bytes = await readFile((await download.path())!), raw = bytes.toString('latin1');
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(raw).toContain('%PDF-1.4'); expect(raw).toContain('/Count 3');
  expect([...raw.matchAll(/\/MediaBox \[0 0 595\.2756 841\.8898\]/g)]).toHaveLength(3);
  expect([...raw.matchAll(/\/Filter \/DCTDecode/g)]).toHaveLength(3);
  expect(bytes.length).toBeGreaterThan(30_000);
});

test('denied autosave leaves the editor usable and does not raise a page error', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); }; });
  await page.goto('/');
  await expect(page.getByLabel('Generation algorithm')).toBeVisible();
  await page.getByLabel('Canvas width', { exact: true }).fill('16');
  await page.getByRole('button', { name: '应用', exact: true }).first().click();
  await expect(page.getByLabel('Canvas width', { exact: true })).toHaveValue('16');
  expect(errors).toEqual([]);
});

test('denied localStorage reads still open a usable editor', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } });
  });
  await page.goto('/');
  await expect(page.getByLabel('Generation algorithm')).toBeVisible();
  await page.getByLabel('Canvas width', { exact: true }).fill('16');
  await page.getByRole('button', { name: '应用', exact: true }).first().click();
  await expect(page.getByLabel('Canvas width', { exact: true })).toHaveValue('16');
  await expect(page.getByRole('button', { name: '导出编辑', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

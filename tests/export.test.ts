import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayer, createProject, normalizeProject, serializeProject, withLayers } from '../src/project';
import { summarizeUsage } from '../src/usage';
import { usageCsv } from '../src/exporters';
import { createImagePdf, exportGrid, printLayout, renderPatternSvg, renderPrintPageSvg, visibleBom } from '../src/beadify/export';
import type { PrintExportOptions } from '../src/beadify/export';

const options: PrintExportOptions = { exportBounds: 'canvas', showColorCodes: true, showGuideLines: true, pitchMm: 5 };
function fixture() {
  const base = createProject(3, 2, 'Visible <pattern> & "BOM"');
  return withLayers(base, [
    { ...base.layers[0], cells: ['mard-h7', 'mard-h7', null, 'mard-h7', null, null], includeInUsage: false },
    { ...createLayer(3, 2, 'Top'), cells: [null, 'mard-h2', 'mard-a1', null, null, null] },
    { ...createLayer(3, 2, 'Hidden'), visible: false, cells: ['mard-a2', null, null, 'mard-a2', 'mard-a2', 'mard-a2'] },
    { ...createLayer(3, 2, 'Zero opacity'), opacity: 0, cells: [null, null, null, null, null, 'mard-a2'] },
  ]);
}

test('PNG/SVG/PDF grid, CSV/JSON BOM and UI usage share the same visible composite', () => {
  const project = fixture();
  project.cells = Array(6).fill('mard-a2'); // Export cannot trust a stale separately cached grid.
  const expected = ['mard-h7', 'mard-h2', 'mard-a1', 'mard-h7', null, null];
  assert.deepEqual(exportGrid(project, options).cells, expected);
  assert.deepEqual(printLayout(project, options).grid.cells, expected);
  const bom = visibleBom(project);
  assert.equal(bom.totalBeads, 4);
  assert.deepEqual(bom.rows.map(row => [row.code, row.count]), [['H7', 2], ['A1', 1], ['H2', 1]]);
  assert.equal(summarizeUsage(project).reduce((sum, row) => sum + row.count, 0), bom.totalBeads);
  const csv = usageCsv(project);
  assert.equal(csv.trim().split(/\r?\n/).slice(1).reduce((sum, row) => sum + Number(row.split(',').at(-1)), 0), 4);
  assert.doesNotMatch(csv, /,A2,/);
  const svg = renderPatternSvg(project, options);
  assert.equal((svg.match(/data-bead=/g) ?? []).length, bom.totalBeads);
  for (const { code, count } of bom.rows) {
    assert.match(svg, new RegExp(`>${code} × ${count}</text>`));
    assert.equal((svg.match(new RegExp(`>${code}</text>`, 'g')) ?? []).length, count);
  }
  assert.match(svg, /Visible &lt;pattern&gt; &amp; &quot;BOM&quot;/);
  assert.doesNotMatch(svg, /<image|data-bead="mard-a2"/);
});

test('SVG and BOM use saved RGB and palette references after JSON reopening', () => {
  const raw = JSON.parse(serializeProject(fixture()));
  raw.beadify.paletteSnapshot.colors.find((color: { code: string }) => color.code === 'H7').srgb8 = [12, 34, 56];
  const project = normalizeProject(raw), svg = renderPatternSvg(project, options), bom = visibleBom(project);
  assert.match(svg, /fill="#0c2238"/);
  assert.deepEqual(bom.rows.find(row => row.code === 'H7')!.srgb8, [12, 34, 56]);
  assert.match(usageCsv(project), /,#0c2238,/);
});

test('page plan covers all cells, uses one-cell overlaps and an unmirrored global BOM', () => {
  const base = createProject(80, 90), project = withLayers(base, [{ ...base.layers[0], cells: Array(80 * 90).fill('mard-h7') }]);
  const layout = printLayout(project, options);
  assert.equal(layout.paperWidthMm, 210); assert.equal(layout.paperHeightMm, 297);
  const pages = layout.pages.filter(page => page.kind === 'pattern');
  assert.equal(pages.length, 6);
  assert.deepEqual(pages.slice(0, 3).map(page => page.x), [0, 35, 70]);
  const covered = new Set<number>();
  for (const page of pages) for (let y = page.y; y < page.y + page.rows; y++) for (let x = page.x; x < page.x + page.columns; x++) covered.add(y * 80 + x);
  assert.equal(covered.size, 80 * 90);
  assert.equal(layout.usage.reduce((sum, row) => sum + row.count, 0), 80 * 90);
  assert.equal(layout.pages.at(-1)!.kind, 'legend');
  const svg = renderPrintPageSvg(project, options, layout, 0);
  assert.match(svg, /width="210mm" height="297mm"/);
  assert.match(svg, /data-calibration-mm="50"/);
  assert.match(svg, /Print at 100%/);
  assert.match(svg, /M15 280H65V280/);
  const letter = printLayout(project, { ...options, paperSize: 'letter', pitchMm: 2.6, overlapCells: 0 });
  assert.equal(letter.paperWidthMm, 215.9); assert.equal(letter.paperHeightMm, 279.4);
  assert.throws(() => printLayout(project, { ...options, pitchMm: 0 }), /pitch/);
  assert.throws(() => printLayout(project, { ...options, overlapCells: 6 }), /overlap/);
});

test('mirror reverses cells while color codes stay readable; crop uses final visible bounds', () => {
  const project = fixture();
  assert.deepEqual(exportGrid(project, { ...options, mirror: true }).cells, ['mard-a1', 'mard-h2', 'mard-h7', null, null, 'mard-h7']);
  const svg = renderPatternSvg(project, { ...options, mirror: true });
  assert.match(svg, /data-bead="mard-a1" data-grid-x="0" data-grid-y="0"/);
  assert.doesNotMatch(svg, /scale\(-1/);
  const emptyMargins = createProject(5, 4);
  emptyMargins.layers[0].cells[7] = 'mard-h7';
  assert.deepEqual(exportGrid(emptyMargins).cells, ['mard-h7']);
  assert.equal(exportGrid(emptyMargins).originX, 2); assert.equal(exportGrid(emptyMargins).originY, 1);
});

test('PDF container preserves exact paper dimensions, page count and binary xref offsets', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const blob = createImagePdf([
    { jpeg, imageWidth: 2100, imageHeight: 2970, widthMm: 210, heightMm: 297 },
    { jpeg, imageWidth: 2159, imageHeight: 2794, widthMm: 215.9, heightMm: 279.4 },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer()), raw = Buffer.from(bytes).toString('latin1');
  assert.match(raw, /\/Count 2/);
  const boxes = [...raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)];
  assert.equal(boxes.length, 2);
  for (const [index, [width, height]] of [[210, 297], [215.9, 279.4]].entries()) {
    assert.ok(Math.abs(Number(boxes[index][1]) * 25.4 / 72 - width) < 0.001);
    assert.ok(Math.abs(Number(boxes[index][2]) * 25.4 / 72 - height) < 0.001);
  }
  const xref = raw.match(/xref\n0 9\n0000000000 65535 f \n([\s\S]*?)trailer/)![1].trim().split('\n');
  for (const [index, row] of xref.entries()) assert.ok(raw.slice(Number(row.slice(0, 10))).startsWith(`${index + 1} 0 obj`));
  const start = Number(raw.match(/startxref\n(\d+)/)![1]);
  assert.equal(raw.slice(start, start + 4), 'xref');
});

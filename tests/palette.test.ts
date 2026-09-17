import test from 'node:test';
import assert from 'node:assert/strict';
import { basicPalette, completePalette } from '../src/palette';
import { workspacePalette } from '../src/beadify/adapter';
import { buildBom, generatePattern } from '../src/beadify/core/index';
import { createProject, normalizeProject, serializeProject, withLayers } from '../src/project';
import { printLayout, renderPatternSvg, renderPrintPageSvg, visibleBom } from '../src/beadify/export';
import { usageCsv } from '../src/exporters';

test('all 221 basic and 291 complete palette entries participate in full-budget CPU matching', () => {
  for (const [colors, count] of [[basicPalette, 221], [completePalette, 291]] as const) {
    assert.equal(colors.length, count);
    assert.equal(new Set(colors.map(color => color.id)).size, count);
    const width = 17, height = Math.ceil(count / width), data = new Uint8ClampedArray(width * height * 4);
    colors.forEach((color, index) => data.set([...color.rgb, 255], index * 4));
    for (const method of ['nearest', 'area', 'dominant'] as const) {
      const pattern = generatePattern({ schemaVersion: 1, revision: 0, image: { width, height, data },
        width, height, method, maxColors: count, palette: workspacePalette([...colors]) });
      const byId = new Map(pattern.paletteSnapshot.colors.map(color => [color.id, color.srgb8]));
      colors.forEach((color, index) => assert.deepEqual(byId.get(pattern.cells[index]!), color.rgb));
      assert.ok(pattern.cells.slice(count).every(color => color === null));
      // Complete MARD has one pair sharing the same approximate RGB; matching
      // preserves the RGB, while manually placed distinct codes remain distinct.
      assert.equal(pattern.diagnostics.usedColors, new Set(colors.map(color => color.rgb.join(','))).size);
      assert.equal(buildBom(pattern).totalBeads, count);
    }
  }
});

test('every basic/complete color code survives saving, BOM and all SVG/PDF legend pages', () => {
  for (const colors of [basicPalette, completePalette]) {
    const width = 17, height = Math.ceil(colors.length / width), project = createProject(width, height, 'Full bead palette');
    const cells = Array<string | null>(width * height).fill(null);
    colors.forEach((color, index) => { cells[index] = color.id; });
    const saved = normalizeProject(JSON.parse(serializeProject(withLayers(project, [{ ...project.layers[0], cells }]))));
    assert.deepEqual(saved.cells, cells);
    const bom = visibleBom(saved);
    assert.equal(bom.rows.length, colors.length);
    assert.equal(bom.totalBeads, colors.length);
    assert.deepEqual(new Set(bom.rows.map(row => row.code)), new Set(colors.map(color => color.primaryCode)));
    assert.ok(bom.rows.every(row => row.count === 1));
    assert.equal(usageCsv(saved).trim().split(/\r?\n/).length, colors.length + 1);
    const options = { showColorCodes: true, showGuideLines: true };
    const svg = renderPatternSvg(saved, options);
    assert.equal((svg.match(/data-bead=/g) ?? []).length, colors.length);
    assert.equal((svg.match(/data-legend=/g) ?? []).length, colors.length);
    const layout = printLayout(saved, options);
    assert.ok(layout.pages.filter(page => page.kind === 'legend').length >= 3);
    const legendIds = layout.pages.flatMap((page, index) => page.kind === 'legend'
      ? [...renderPrintPageSvg(saved, options, layout, index).matchAll(/data-legend="([^"]+)"/g)].map(match => match[1]) : []);
    assert.equal(legendIds.length, colors.length);
    assert.deepEqual(new Set(legendIds), new Set(colors.map(color => color.id)));
  }
});

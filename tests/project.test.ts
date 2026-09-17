import test from 'node:test';
import assert from 'node:assert/strict';
import { autosaveKey, composeVisibleCells, createLayer, createProject, loadDraft, normalizeProject, projectColor, saveDraft, saveDraftWithStatus, serializeProject, serializeProjectWithStatus, PROJECT_JSON_MAX_BYTES, withLayers } from '../src/project';
import { summarizeUsage } from '../src/usage';
import { workspacePalette } from '../src/beadify/adapter';
import { basicPalette } from '../src/palette';
import { createSourceRaster } from '../src/beadify/core/source-raster';
import { patternGeometry, validateSourceRaster } from '../src/beadify/core/validation';
import { hashJson } from '../src/beadify/core/hash';

test('legacy cells without layers survive migration and get current default settings', () => {
  const cells = ['mard-h7', null, 'mard-h2', null];
  for (const layers of [undefined, []]) {
    const restored = normalizeProject({ width: 2, height: 2, cells, layers, settings: { beadDisplayMode: 'print' } });
    assert.deepEqual(restored.cells, cells);
    assert.deepEqual(restored.layers[0].cells, cells);
    assert.equal(restored.activeLayerId, 'base');
    assert.equal(restored.settings.beadDisplayMode, 'bead');
    assert.equal(restored.settings.showColorCodes, true);
    assert.equal(restored.settings.beadsPerPack, 500);
    restored.layers[0].cells[0] = null;
    assert.equal(cells[0], 'mard-h7');
  }
});

test('project import rejects invalid dimensions before allocating cells', () => {
  for (const value of [0, -1, 0.5, 257, Number.MAX_SAFE_INTEGER, Infinity, NaN, '2', null]) {
    assert.throws(() => normalizeProject({ width: value, height: 1, cells: [] }), /width and height/);
    assert.throws(() => normalizeProject({ width: 1, height: value, cells: [] }), /width and height/);
  }
  for (const input of [null, undefined, [], 'project']) assert.throws(() => normalizeProject(input), /Invalid project/);
  assert.equal(normalizeProject({ width: 256, height: 1, cells: Array(256).fill(null) }).cells.length, 256);
});

test('import rejects truncated grids, unknown colors, malformed layers and invalid settings', () => {
  const valid = createProject(2, 1);
  for (const cells of [[null], [null, null, null], ['unregistered', null], ['', null], [false, null], [undefined, null]]) {
    assert.throws(() => normalizeProject({ ...valid, cells }), /cells/);
  }
  assert.throws(() => normalizeProject({ ...valid, layers: { cells: [null, null] } }), /layers/);
  assert.throws(() => normalizeProject({ ...valid, layers: Array.from({ length: 101 }, (_, i) => ({ ...valid.layers[0], id: String(i) })) }), /100/);
  assert.throws(() => normalizeProject({ ...valid, layers: [valid.layers[0], valid.layers[0]] }), /duplicate/);
  assert.throws(() => normalizeProject({ ...valid, layers: [{ ...valid.layers[0], cells: [null] }] }), /layer.cells/);
  assert.throws(() => normalizeProject({ ...valid, layers: [{ ...valid.layers[0], cells: ['unknown', null] }] }), /unknown color/);
  assert.throws(() => normalizeProject({ ...valid, layers: [{ ...valid.layers[0], visible: 'false' }] }), /visible/);
  assert.throws(() => normalizeProject({ ...valid, layers: [{ ...valid.layers[0], opacity: NaN }] }), /opacity/);
  assert.throws(() => normalizeProject({ ...valid, layers: [{ ...valid.layers[0], cells: ['mard-h7', null] }] }), /do not match/);
  assert.throws(() => normalizeProject({ ...valid, settings: null }), /settings/);
  assert.throws(() => normalizeProject({ ...valid, settings: { beadsPerPack: 0 } }), /beadsPerPack/);
  assert.throws(() => normalizeProject({ ...valid, boardSettings: { boardWidth: 0 } }), /boardWidth/);
});

test('JSON roundtrip preserves current layers and a validated independent palette snapshot', () => {
  const project = createProject(2, 1, '项目 JSON');
  const withGrid = withLayers(project, [{ ...project.layers[0], cells: ['mard-h7', null] }]);
  withGrid.beadify = {
    schemaVersion: 1,
    paletteSnapshot: workspacePalette(basicPalette),
    lastGeneration: { method: 'area', inputRevision: 3, configHash: `sha256:${'0'.repeat(64)}` },
  };
  const parsed = JSON.parse(JSON.stringify(withGrid));
  const restored = normalizeProject(parsed);
  assert.deepEqual(restored, withGrid);
  restored.beadify!.paletteSnapshot.colors[0].srgb8[0] = 0;
  assert.notEqual(parsed.beadify.paletteSnapshot.colors[0].srgb8[0], 0);
  parsed.beadify.schemaVersion = 2;
  assert.throws(() => normalizeProject(parsed), /schemaVersion/);
  parsed.beadify.schemaVersion = 1;
  parsed.beadify.paletteSnapshot.colors[0].srgb8[0] = 300;
  assert.throws(() => normalizeProject(parsed), /srgb8/);
  parsed.beadify.paletteSnapshot = withGrid.beadify.paletteSnapshot;
  parsed.beadify.lastGeneration.inputRevision = -1;
  assert.throws(() => normalizeProject(parsed), /lastGeneration/);
});

test('composition and usage respect visible layer order, transparent cells and final physical beads', () => {
  const project = createProject(2, 1);
  const layers = [
    { ...project.layers[0], cells: ['mard-h7', 'mard-h7'] },
    { ...createLayer(2, 1, 'Top'), cells: ['mard-h2', null] },
    { ...createLayer(2, 1, 'Hidden'), visible: false, cells: [null, 'mard-a1'] },
  ];
  assert.deepEqual(composeVisibleCells(layers, 2, 1), ['mard-h2', 'mard-h7']);
  const composed = withLayers(project, layers);
  assert.equal(composed.cells.filter(Boolean).length, 2);
  const counts = new Map(summarizeUsage(composed).map((row) => [row.color.id, row.count]));
  assert.deepEqual(counts, new Map([['mard-h2', 1], ['mard-h7', 1]]));
  layers[2].includeInUsage = false;
  assert.equal(summarizeUsage(withLayers(project, layers)).reduce((sum, row) => sum + row.count, 0), 2);
});

test('draft roundtrip is validated, malformed drafts and unavailable storage return null', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  try {
    const project = createProject(1, 1);
    saveDraft(project);
    assert.deepEqual(loadDraft(), normalizeProject(JSON.parse(serializeProject(project))));
    for (const raw of ['{bad json', 'null', JSON.stringify({ width: -1, height: 1, cells: [] })]) {
      storage.set(autosaveKey, raw);
      assert.equal(loadDraft(), null);
      assert.equal(storage.has(autosaveKey), false);
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
    assert.equal(loadDraft(), null);
    assert.equal(saveDraft(project), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('saved palette colors override the current installation and cover edits in hidden layers', () => {
  const initial = createProject(2, 1, 'No original image required');
  const edited = withLayers(initial, [
    { ...initial.layers[0], cells: ['mard-h7', null] },
    { ...createLayer(2, 1, 'Hidden work'), visible: false, cells: [null, 'mard-a1'] },
  ]);
  const restored = normalizeProject(JSON.parse(serializeProject(edited)));
  const snapshot = restored.beadify!.paletteSnapshot;
  assert.ok(snapshot.colors.some(color => color.code === 'A1'));
  const h7 = snapshot.colors.find(color => color.code === 'H7')!;
  h7.srgb8 = [12, 34, 56];
  const future = normalizeProject(JSON.parse(serializeProject(restored)));
  assert.equal(projectColor(future, 'mard-h7')?.hex, '#0c2238');
  assert.deepEqual(future.layers.map(layer => layer.cells), edited.layers.map(layer => layer.cells));
  assert.equal('image' in future, false);
});

test('project metadata preserves generation choices and independent constraints without a source image', () => {
  const project = createProject(2, 1);
  project.beadify = {
    schemaVersion: 1, paletteSnapshot: workspacePalette(basicPalette),
    lastGeneration: { method: 'optimized', inputRevision: 7, configHash: null },
    generationSettings: { method: 'optimized', width: 2, height: 1, maxColors: 3, sourceName: 'portrait.png',
      style: 'clean', preprocessing: { crop: [4, 5, 30, 40], mask: [0, 1, 2], background: 'edge', tolerance: 20 },
      optimization: { iterations: 2, maxEvaluations: 1000, symmetry: true }, phase: [0.25, -0.25],
      allowedColors: ['MARD:unspecified:H7', 'MARD:unspecified:H2'], requiredColors: ['MARD:unspecified:H7'] },
    constraints: [{ kind: 'lock-color', cellIndices: [0], colorId: 'MARD:unspecified:H7' }, { kind: 'lock-empty', cellIndices: [1] }],
  };
  const raw = JSON.parse(serializeProject(project));
  const restored = normalizeProject(raw);
  assert.deepEqual(restored.beadify, project.beadify);
  restored.beadify!.constraints![0].cellIndices[0] = 1;
  assert.equal(raw.beadify.constraints[0].cellIndices[0], 0);
  restored.beadify!.generationSettings!.preprocessing!.mask![0] = 2;
  assert.equal(raw.beadify.generationSettings.preprocessing.mask[0], 0);
  for (const [key, value] of [['schemaVersion', 2], ['futureConstraint', {}]]) {
    const invalid = structuredClone(raw); invalid.beadify[key] = value;
    assert.throws(() => normalizeProject(invalid), /schemaVersion|unsupported/);
  }
  for (const modify of [
    (p: typeof raw) => { p.version = '2.0.0'; },
    (p: typeof raw) => { p.beadify.constraints[0].cellIndices = [2]; },
    (p: typeof raw) => { p.beadify.constraints[0].colorId = 'missing'; },
    (p: typeof raw) => { p.beadify.generationSettings.sourceName = 'x'.repeat(256); },
    (p: typeof raw) => { p.beadify.generationSettings.phase = [NaN, 0]; },
    (p: typeof raw) => { p.beadify.generationSettings.preprocessing.crop = [4095, 0, 2, 10]; },
    (p: typeof raw) => { p.beadify.generationSettings.optimization.iterations = 31; },
  ]) { const invalid = structuredClone(raw); modify(invalid); assert.throws(() => normalizeProject(invalid), /Invalid project/); }
});

test('zero-opacity layers do not produce physical beads or usage', () => {
  const project = createProject(1, 1);
  const layers = [{ ...project.layers[0], cells: ['mard-h7'] }, { ...createLayer(1, 1, 'Invisible'), opacity: 0, cells: ['mard-h2'] }];
  const result = withLayers(project, layers);
  assert.deepEqual(result.cells, ['mard-h7']);
  assert.deepEqual(summarizeUsage(result).map(row => [row.color.id, row.count]), [['mard-h7', 1]]);
});

test('legacy cached grid with a zero-opacity overlay migrates without losing layer edits', () => {
  const project = createProject(1, 1);
  project.layers[0].cells = ['mard-h7'];
  project.layers.push({ ...createLayer(1, 1, 'Old overlay'), opacity: 0, cells: ['mard-h2'] });
  project.cells = ['mard-h2']; // Old composition included zero opacity.
  const restored = normalizeProject(project);
  assert.deepEqual(restored.cells, ['mard-h7']);
  assert.deepEqual(restored.layers[1].cells, ['mard-h2']);
});

function projectWithUniformSourceEvidence(side: number) {
  const palette = workspacePalette(basicPalette), image = { width: 1, height: 1, data: [250, 211, 100, 255] };
  const original = createSourceRaster({ schemaVersion: 1, revision: 0, image, palette, width: 1, height: 1, method: 'dominant', maxColors: 1, phase: [0, 0] });
  // A uniform 1-pixel original upscaled over the canvas has identical evidence
  // in every cell. Share references to exercise real serialized size without
  // retaining thousands of redundant object graphs in the test process.
  const { configHash: _hash, ...source } = original;
  const geometry = patternGeometry(1, 1, side, side, undefined, [0, 0]);
  const content = { ...source, width: side, height: side, frameWidth: side, frameHeight: side, geometry,
    cells: Array(side * side).fill(original.cells[0]),
    inputHash: hashJson({ engine: 'beadify-source-v4', rgba: original.sourceHash, width: 1, height: 1, preprocessing: null, geometry, style: 'clean', sampling: {}, sourceFeatures: [] }) };
  const raster = { ...content, configHash: hashJson(content) };
  validateSourceRaster(raster);
  const base = createProject(side, side, '保存图纸及隐藏图层');
  const project = withLayers(base, [{ ...base.layers[0], cells: Array(side * side).fill('mard-h7') }, { ...createLayer(side, side, 'Hidden edits'), visible: false, cells: Array(side * side).fill('mard-h2') }]);
  project.beadify = { schemaVersion: 1, paletteSnapshot: palette, lastGeneration: { method: 'dominant', inputRevision: 0, configHash: null }, sourceRaster: raster,
    generationSettings: { method: 'dominant', width: side, height: side, maxColors: 1, sourceHash: raster.sourceHash, sourceName: 'source.png', phase: [0, 0], preprocessing: { mask: [1] } },
    constraints: [{ kind: 'lock-color', cellIndices: [0], colorId: 'MARD:unspecified:H7' }, { kind: 'protect', cellIndices: [side * side - 1] }] };
  return project;
}

test('optional source evidence exceeding the actual 20 MiB limit is omitted without losing editing data', () => {
  const project = projectWithUniformSourceEvidence(180), raster = project.beadify!.sourceRaster;
  assert.ok(Buffer.byteLength(JSON.stringify(raster)) > PROJECT_JSON_MAX_BYTES, 'fixture exceeds the real import budget, not a lowered test threshold');
  const saved = serializeProjectWithStatus(project);
  assert.equal(saved.sourceRasterOmitted, true); assert.equal(saved.reason, 'file-budget');
  assert.ok(Buffer.byteLength(saved.json) <= PROJECT_JSON_MAX_BYTES);
  const reopened = normalizeProject(JSON.parse(saved.json));
  assert.equal(reopened.beadify!.sourceRaster, undefined);
  assert.equal(reopened.beadify!.sourceRasterOmission, 'file-budget');
  assert.deepEqual(reopened.cells, project.cells);
  assert.deepEqual(reopened.layers.map(layer => layer.cells), project.layers.map(layer => layer.cells));
  assert.deepEqual(reopened.beadify!.generationSettings, project.beadify!.generationSettings);
  assert.deepEqual(reopened.beadify!.constraints, project.beadify!.constraints);
  assert.deepEqual(reopened.beadify!.paletteSnapshot, project.beadify!.paletteSnapshot);
  assert.equal(project.beadify!.sourceRaster, raster, 'omission must not mutate the live editing project');
  assert.equal(project.beadify!.sourceRasterOmission, undefined);
  assert.equal(serializeProjectWithStatus(reopened).reason, 'file-budget');
});

test('small source caches remain lossless and new cache serialization clears an old omission marker', () => {
  const project = projectWithUniformSourceEvidence(4);
  project.beadify!.sourceRasterOmission = 'storage-quota';
  const saved = serializeProjectWithStatus(project);
  assert.equal(saved.sourceRasterOmitted, false);
  const reopened = normalizeProject(JSON.parse(saved.json));
  assert.deepEqual(reopened.beadify!.sourceRaster, project.beadify!.sourceRaster);
  assert.equal(reopened.beadify!.sourceRasterOmission, undefined);
  assert.throws(() => normalizeProject({ ...reopened, beadify: { ...reopened.beadify, sourceRasterOmission: 'unknown' } }), /sourceRasterOmission/);
});

test('autosave retries quota overflow once without optional cache and records the successful fallback', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), project = projectWithUniformSourceEvidence(4);
  const cacheless = serializeProjectWithStatus(project, { omitSourceRaster: 'storage-quota' }).json;
  const quota = Buffer.byteLength(cacheless) + 128, attempts: string[] = [], storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => { attempts.push(value); if (Buffer.byteLength(value) > quota) throw new DOMException('Quota reached', 'QuotaExceededError'); storage.set(key, value); },
  } });
  try {
    assert.deepEqual(saveDraftWithStatus(project), { saved: true, sourceRasterOmitted: true, reason: 'storage-quota' });
    assert.equal(attempts.length, 2);
    const reopened = loadDraft()!;
    assert.deepEqual(reopened.cells, project.cells); assert.deepEqual(reopened.layers.map(layer => layer.cells), project.layers.map(layer => layer.cells));
    assert.deepEqual(reopened.beadify!.constraints, project.beadify!.constraints);
    assert.deepEqual(reopened.beadify!.generationSettings, project.beadify!.generationSettings);
    assert.equal(reopened.beadify!.sourceRasterOmission, 'storage-quota');
    assert.equal(reopened.beadify!.sourceRaster, undefined);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

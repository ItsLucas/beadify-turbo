import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerationRequest, SourceFeatureRegion, SourceRaster } from '../src/beadify/contracts';
import { createSourceRaster, generatePattern, resizeSourceRaster, toJsonRequest, validatePattern, validateRequest } from '../src/beadify/core';
import { hashJson } from '../src/beadify/core/hash';
import { validateSourceRaster } from '../src/beadify/core/validation';
import { createProject, normalizeProject, serializeProject, withLayers } from '../src/project';
import { currentRaster, roiConstraints, sourceRoiRequest } from '../src/beadify/workspace-generation';
import { createDetailFixtures } from '../benchmark/detail-fixtures';
import Ajv from 'ajv';
import schema from '../src/beadify/contracts/schema.json';

const fileHash = `sha256:${'a'.repeat(64)}`;
function sourceRequest(): GenerationRequest {
  const fixture = createDetailFixtures().find(entry => entry.id === 'dark-line-s8-p0_0')!;
  const palette = { ...fixture.request.palette, colors: fixture.request.palette.colors.map(color => ({ ...color, id: `MARD:Test:${color.id}`, brand: 'MARD' })) };
  const runs: [number, number][] = [];
  fixture.sourceFeatureMask.forEach((value, index) => {
    if (!value) return;
    const previous = runs.at(-1);
    if (previous && previous[0] + previous[1] === index) previous[1]++;
    else runs.push([index, 1]);
  });
  const feature: SourceFeatureRegion = { id: 'mouth', label: 'Line', mask: { width: fixture.request.image.width, height: fixture.request.image.height, runs },
    colorIds: ['MARD:Test:D'], minCells: 4, importance: 1, confidence: 1, allowSingleton: true };
  return { ...fixture.request, palette: palette as GenerationRequest['palette'], sourceFeatures: [feature], optimization: { restarts: 1 } };
}
function cachedRequest(request: GenerationRequest): GenerationRequest {
  const { preprocessing: _p, sampling: _s, phase: _ph, sourceFeatures: _f, ...settings } = request;
  return { ...settings, preparedRaster: createSourceRaster(request, fileHash) };
}

test('source feature projection respects original crop, fractional phase and removed alpha', () => {
  const request = sourceRequest();
  const data = Array.from({ length: 32 }, () => [250, 211, 100, 255]).flat();
  data[11 * 4 + 3] = 0;
  const feature = { ...request.sourceFeatures![0], minCells: 2, mask: { width: 8, height: 4, runs: [[11, 1], [19, 1]] as [number, number][] } };
  const raster = createSourceRaster({ ...request, image: { width: 8, height: 4, data }, width: 4, height: 4,
    preprocessing: { crop: [2, 0, 6, 4] }, phase: [.25, 0], sourceFeatures: [feature] }, fileHash);
  assert.deepEqual(raster.features[0].cellIndices, [9, 10]);
  assert.equal(raster.features[0].minCells, 2);
  assert.deepEqual(raster.geometry.sourceToGrid, [1, 0, -1.75, 0, 1, 0, 0, 0, 1]);
});

test('fresh and serialized source evidence give identical optimized grids, terms and restart traces', () => {
  const validateSchema = new Ajv({ strict: false }).compile(schema);
  for (const sourceEdges of [true, false]) {
    const request = { ...sourceRequest(), sampling: { sourceEdges, strategy: 'modes' as const }, preprocessing: { smoothing: true } };
    const direct = generatePattern(request), replay = cachedRequest(request);
    replay.preparedRaster = JSON.parse(JSON.stringify(replay.preparedRaster));
    const cached = generatePattern(replay);
    assert.deepEqual(cached.cells, direct.cells);
    assert.deepEqual(cached.diagnostics.optimization, direct.diagnostics.optimization);
    assert.deepEqual(cached.geometry, direct.geometry);
    validatePattern(cached);
    assert.deepEqual(toJsonRequest(replay).preparedRaster, replay.preparedRaster);
    for (const value of [toJsonRequest(request), replay.preparedRaster, toJsonRequest(replay), cached]) {
      assert.ok(validateSchema(value), JSON.stringify(validateSchema.errors));
    }
  }
});

test('source ROI restores original features after project reopening while locking every exterior edit', () => {
  const request = sourceRequest(), raster = createSourceRaster(request, fileHash), base = createProject(8, 6);
  const cells = Array<string | null>(48).fill('mard-y'); cells[0] = 'mard-w'; cells[47] = null;
  const project = withLayers(base, [{ ...base.layers[0], cells }]);
  project.beadify = { schemaVersion: 1, paletteSnapshot: request.palette, sourceRaster: raster,
    lastGeneration: { method: 'optimized', inputRevision: 0, configHash: null },
    generationSettings: { method: 'optimized', width: 8, height: 6, maxColors: 3, sourceHash: fileHash, sourceFeatures: request.sourceFeatures } };
  const restored = normalizeProject(JSON.parse(serializeProject(project)));
  const indices = Array.from({ length: 8 }, (_, x) => 3 * 8 + x);
  const config = { maxColors: 3, optimization: { restarts: 1 } };
  const recovered = generatePattern(sourceRoiRequest(restored, request.palette, indices, config));
  const cleaned = generatePattern({ ...config, schemaVersion: 1, revision: 0, width: 8, height: 6, palette: request.palette,
    image: currentRaster(restored), method: 'optimized', constraints: roiConstraints(restored, request.palette, indices) });
  assert.ok(indices.filter(index => recovered.cells[index] === 'MARD:Test:D').length >= 4);
  assert.ok(indices.every(index => cleaned.cells[index] !== 'MARD:Test:D'));
  for (let index = 0; index < 48; index++) if (!indices.includes(index)) {
    assert.equal(recovered.cells[index], cells[index] === null ? null : `MARD:Test:${cells[index]!.slice(5).toUpperCase()}`);
  }
  assert.equal(recovered.diagnostics.optimization!.hardConstraintsSatisfied, true);
});

test('global feature minima count already preserved locked exterior cells during ROI recalculation', () => {
  const request = sourceRequest(), base = createProject(3, 1);
  const project = withLayers(base, [{ ...base.layers[0], cells: ['mard-d', 'mard-y', 'mard-y'] }]);
  project.beadify = { schemaVersion: 1, paletteSnapshot: request.palette, lastGeneration: { method: 'optimized', configHash: null, inputRevision: 0 },
    constraints: [{ kind: 'feature', cellIndices: [0, 1, 2], colorIds: ['MARD:Test:D'], minCells: 2 }] };
  const constraints = roiConstraints(project, request.palette, [1, 2]);
  assert.deepEqual(constraints[0].cellIndices, [0, 1, 2]);
  assert.ok(constraints.some(c => c.kind === 'lock-color' && c.cellIndices.includes(0)));
});

test('cached source transforms survive padding/cropping and reject tampered evidence or mismatched source', () => {
  const request = sourceRequest(), raster = createSourceRaster(request, fileHash);
  const padded = resizeSourceRaster(raster, 10, 7);
  validateSourceRaster(padded);
  assert.deepEqual(padded.geometry.sourceToGrid, raster.geometry.sourceToGrid);
  assert.equal(padded.geometry.frameWidth, 8); assert.equal(padded.geometry.frameHeight, 6);
  for (let y = 0; y < 6; y++) assert.deepEqual(padded.cells.slice(y * 10, y * 10 + 8), raster.cells.slice(y * 8, y * 8 + 8));
  assert.ok(padded.cells.slice(60).every(cell => cell === null));
  const { preprocessing: _p, sampling: _s, phase: _ph, sourceFeatures: _f, ...rest } = request;
  validatePattern(generatePattern({ ...rest, width: 10, height: 7, preparedRaster: padded }));
  validateSourceRaster(resizeSourceRaster(padded, 4, 4));
  const modified = structuredClone(raster); modified.cells[0]!.mean.L += .01;
  assert.throws(() => validateSourceRaster(modified), /changed/);
  const invalidWeights = structuredClone(raster); invalidWeights.cells[0]!.modes[0].weight = .1;
  const { configHash: _hash, ...body } = invalidWeights; invalidWeights.configHash = hashJson(body);
  assert.throws(() => validateSourceRaster(invalidWeights), /sum to one/);
  assert.throws(() => generatePattern({ ...cachedRequest(request), sampling: { strategy: 'mean' } }), /resampling/);
});

test('source labels reject invalid RLE, frame/color references and unsupported feature options', () => {
  for (const change of [
    (r: GenerationRequest) => { r.sourceFeatures![0].mask.runs = [[5, 4], [6, 2]]; },
    (r: GenerationRequest) => { r.sourceFeatures![0].mask.runs = [[0, 0]]; },
    (r: GenerationRequest) => { r.sourceFeatures![0].mask.width++; },
    (r: GenerationRequest) => { r.sourceFeatures![0].colorIds = ['unknown']; },
    (r: GenerationRequest) => { r.sourceFeatures![0].minCells = 1.5; },
    (r: GenerationRequest) => { r.constraints = [{ kind: 'lock-color', cellIndices: [0], colorId: 'MARD:Test:D', minCells: 1 }]; },
    (r: GenerationRequest) => { r.constraints = [{ kind: 'feature', cellIndices: [0], colorId: 'MARD:Test:D', colorIds: ['MARD:Test:Y'] }]; },
  ]) { const request = sourceRequest(); change(request); assert.throws(() => validateRequest(request)); }
  const emptyFeature = sourceRequest(); emptyFeature.sourceFeatures![0].importance = 0;
  assert.deepEqual(createSourceRaster(emptyFeature).features, []);
});

function componentRequest(): GenerationRequest {
  const request = sourceRequest(), width = 32, height = 24;
  const data = Array.from({ length: width * height }, () => [250, 211, 100, 255]).flat();
  const paint = (left: number, top: number, right: number, bottom: number, rgb: number[]) => {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) for (let channel = 0; channel < 3; channel++) data[4 * (y * width + x) + channel] = rgb[channel];
  };
  paint(6, 11, 26, 13, [20, 10, 0]); paint(2, 3, 6, 7, [250, 250, 250]);
  const { sourceFeatures: _features, ...base } = request;
  return { ...base, image: { width, height, data }, width: 4, height: 3, phase: [.2, -.15], preprocessing: { smoothing: true }, optimization: { restarts: 3, maxEvaluations: 3000 } };
}
function rehashRaster(raster: SourceRaster): void {
  const { configHash: _hash, ...content } = raster;
  raster.configHash = hashJson(content);
}

test('serialized compact and cross-cell stroke evidence replays exact objectives without source labels', () => {
  const request = componentRequest(), replay = cachedRequest(request), raster = replay.preparedRaster!;
  assert.equal(raster.algorithmVersion, 5);
  const components = raster.cells.flatMap(cell => cell?.modes.flatMap(mode => mode.components ?? []) ?? []);
  assert.ok(components.some(component => component.kind === 'compact'));
  const strokes = components.filter(component => component.kind === 'stroke');
  assert.ok(strokes.length >= 2);
  assert.ok(new Set(strokes.map(component => component.id)).size < strokes.length, 'several cells reference the same original stroke');
  assert.deepEqual(raster.features, [], 'geometric source evidence is not relabeled as manual annotation');
  replay.preparedRaster = JSON.parse(JSON.stringify(raster));
  validateSourceRaster(replay.preparedRaster);
  const schemaValidate = new Ajv({ strict: false }).compile(schema);
  assert.ok(schemaValidate(replay.preparedRaster), JSON.stringify(schemaValidate.errors));
  const direct = generatePattern(request), cached = generatePattern(replay);
  assert.deepEqual(cached.cells, direct.cells);
  assert.deepEqual(cached.geometry, direct.geometry);
  assert.deepEqual(cached.diagnostics.optimization, direct.diagnostics.optimization);
  const disabled = { ...request, sampling: { sourceEdges: false } };
  const disabledCache = cachedRequest(disabled);
  assert.ok(disabledCache.preparedRaster!.cells.every(cell => !cell || cell.modes.every(mode => mode.components === undefined)));
  assert.deepEqual(generatePattern(disabledCache).diagnostics.optimization, generatePattern(disabled).diagnostics.optimization);
});

test('source component evidence rejects malformed fields independently of its content hash', () => {
  const base = createSourceRaster(componentRequest()), schemaValidate = new Ajv({ strict: false }).compile(schema);
  type Component = NonNullable<NonNullable<SourceRaster['cells'][number]>['modes'][number]['components']>[number];
  const corruptions: Array<[string, (component: Component) => void]> = [
    ['negative identity', component => { component.id = -1; }],
    ['fractional identity', component => { component.id = .25; }],
    ['excessive identity', component => { component.id = 4194304; }],
    ['negative coverage', component => { component.coverage = -.01; }],
    ['excessive coverage', component => { component.coverage = 1.01; }],
    ['negative support', component => { component.support = -.01; }],
    ['excessive support', component => { component.support = 1.01; }],
    ['negative span', component => { component.span = -.01; }],
    ['excessive span', component => { component.span = 4097; }],
    ['invalid endpoint mask', component => { component.endpointMask = 4; }],
    ['fractional endpoint mask', component => { component.endpointMask = .5; }],
    ['negative thickness', component => { component.thickness = -.1; }],
    ['excessive thickness', component => { component.thickness = 4097; }],
    ['excessive contrast', component => { component.contrast = 1.01; }],
    ['invalid closed flag', component => { Object.assign(component, { closed: 'yes' }); }],
    ['unknown kind', component => { (component as unknown as { kind: string }).kind = 'semantic-eye'; }],
    ['missing field', component => { delete (component as Partial<Component>).support; }],
    ['unknown field', component => { Object.assign(component, { inferredLabel: 'eye' }); }],
  ];
  for (const [label, corrupt] of corruptions) {
    const raster = structuredClone(base), mode = raster.cells.flatMap(cell => cell?.modes ?? []).find(mode => mode.components?.length)!;
    corrupt(mode.components![0]); rehashRaster(raster);
    assert.throws(() => validateSourceRaster(raster), /component/, label);
    assert.equal(schemaValidate(raster), false, `JSON Schema rejects ${label}`);
  }
  for (const field of ['boundarySupport', 'compactSupport'] as const) {
    const raster = structuredClone(base); raster.cells.find(cell => cell !== null)!.modes[0][field] = 1.1; rehashRaster(raster);
    assert.throws(() => validateSourceRaster(raster), new RegExp(field));
    assert.equal(schemaValidate(raster), false);
  }
  const excessive = structuredClone(base), mode = excessive.cells.flatMap(cell => cell?.modes ?? []).find(mode => mode.components?.length)!;
  mode.components = Array.from({ length: 3 }, (_, id) => ({ ...mode.components![0], id })); rehashRaster(excessive);
  assert.throws(() => validateSourceRaster(excessive), /components/);
  assert.equal(schemaValidate(excessive), false);
  const nonfinite = structuredClone(base); nonfinite.cells.flatMap(cell => cell?.modes ?? []).find(mode => mode.components?.length)!.components![0].coverage = NaN;
  assert.throws(() => validateSourceRaster(nonfinite), /coverage/);
});

test('legacy source raster replay remains valid and explains how to rebuild missing line and shape evidence', () => {
  const request = componentRequest(), replay = cachedRequest(request), base = replay.preparedRaster!;
  for (const version of [undefined, 3, 4] as const) {
    const legacy = structuredClone(base);
    if (version === undefined) delete legacy.algorithmVersion;
    else legacy.algorithmVersion = version;
    for (const cell of legacy.cells) for (const mode of cell?.modes ?? []) { delete mode.components; delete mode.boundarySupport; delete mode.compactSupport; }
    rehashRaster(legacy); validateSourceRaster(legacy);
    const restored = generatePattern({ ...replay, preparedRaster: legacy });
    validatePattern(restored);
    assert.ok(restored.diagnostics.warnings.some(warning => /predates source line/.test(warning) && /original image/.test(warning)));
    assert.deepEqual(generatePattern({ ...replay, preparedRaster: JSON.parse(JSON.stringify(legacy)) }), restored);
  }
  assert.ok(!generatePattern(replay).diagnostics.warnings.some(warning => /predates source line/.test(warning)));
  const future = structuredClone(base); future.algorithmVersion = 6; rehashRaster(future);
  assert.throws(() => validateSourceRaster(future), /algorithmVersion/);
});

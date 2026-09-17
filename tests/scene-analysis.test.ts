import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import schema from '../src/beadify/contracts/schema.json';
import { createSceneAnalysis, sceneFeature, matchingScene, validateSceneAnalysis } from '../src/beadify/core/scene-analysis';
import { hashJson, sha256 } from '../src/beadify/core/hash';
import { generatePattern, buildBom } from '../src/beadify/core';
import { createProject, normalizeProject, serializeProject, withCells } from '../src/project';
import { workspacePalette } from '../src/beadify/adapter';
import { basicPalette } from '../src/palette';
import type { RgbaImage, SceneAnalysis } from '../src/beadify/contracts';

function fixture() {
  const image: RgbaImage = { width: 32, height: 32, data: Array.from({ length: 1024 }, () => [255, 220, 50, 255]).flat() };
  for (let x = 7; x < 25; x++) for (let c = 0; c < 3; c++) image.data[(18 * 32 + x) * 4 + c] = 20;
  image.data[(17 * 32 + 8) * 4 + 3] = 0; image.data[(17 * 32 + 8) * 4] = 0;
  const draft: Omit<SceneAnalysis, 'contentHash'> = { schemaVersion: 1, kind: 'scene-analysis', sourceHash: sha256(image.data), sourceWidth: 32, sourceHeight: 32,
    roi: [0, 0, 32, 32], goal: '保留主体与细嘴', summary: '原创黄色面部', provider: { kind: 'fixture', id: 'scene-test', version: '1', modelHash: null, promptHash: null, configHash: hashJson({ test: 1 }), device: 'none' },
    regions: [{ id: 'subject', label: '主体', kind: 'subject', box: [2, 2, 30, 30], color: 'mixed', importance: 'high' },
      { id: 'mouth', label: '嘴', kind: 'detail', box: [6, 16, 26, 21], color: 'dark', importance: 'high' }] };
  return { image, analysis: createSceneAnalysis(draft), palette: workspacePalette(basicPalette) };
}

test('scene contracts round trip, bind original pixels and reject tampering, invalid boxes and duplicate regions', () => {
  const { image, analysis } = fixture();
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.equal(validate(analysis), true, JSON.stringify(validate.errors));
  validateSceneAnalysis(JSON.parse(JSON.stringify(analysis))); assert.equal(matchingScene(analysis, image), true);
  assert.equal(matchingScene(analysis, { ...image, data: new Uint8ClampedArray(4096) }), false);
  assert.throws(() => validateSceneAnalysis({ ...analysis, summary: 'tampered' }), /校验/);
  const { contentHash: _hash, ...draft } = analysis;
  for (const box of [[0, 0, 33, 2], [1, 0, 1, 2], [NaN, 0, 4, 4], [0.2, 0, 4, 4]]) {
    assert.throws(() => createSceneAnalysis({ ...draft, regions: [{ ...draft.regions[0], box: box as [number, number, number, number] }] }), /建议框/);
  }
  assert.throws(() => createSceneAnalysis({ ...draft, regions: [draft.regions[0], draft.regions[0]] }), /重复/);
  assert.throws(() => createSceneAnalysis({ ...draft, roi: [10, 10, 20, 20] }), /分析范围/);
  assert.throws(() => validateSceneAnalysis({ ...analysis, path: '/tmp/input' }), /未知字段/);
});

test('detail protection uses only matching visible source pixels and existing allowed palette colors', () => {
  const { image, analysis, palette } = fixture(), before = [...image.data];
  const result = sceneFeature(image, analysis, analysis.regions[1], palette, 2);
  assert.equal(result.pixels, 18); assert.deepEqual(result.feature.mask.runs, [[18 * 32 + 7, 18]]);
  assert.equal(result.feature.minCells, 2); assert.deepEqual(image.data, before);
  assert.ok(palette.colors.some(c => result.feature.colorIds.includes(c.id)));
  assert.throws(() => sceneFeature(image, analysis, analysis.regions[0], palette), /选择/);
  assert.throws(() => sceneFeature(image, analysis, { ...analysis.regions[1], box: [0, 0, 4, 4] }, palette), /没有足够/);
  const white = palette.colors.find(c => c.srgb8.every(v => v > 240))!;
  assert.throws(() => sceneFeature(image, analysis, analysis.regions[1], { ...palette, colors: [white] }), /接近/);
  assert.throws(() => sceneFeature({ ...image, data: new Uint8ClampedArray(4096) }, analysis, analysis.regions[1], palette), /当前原图/);
});

test('adopted scene evidence enters the same constrained core as manual evidence, without provider identity changing output', () => {
  const { image, analysis, palette } = fixture();
  const feature = sceneFeature(image, analysis, analysis.regions[1], palette).feature;
  const request = { schemaVersion: 1 as const, revision: 1, method: 'optimized' as const, image, palette, width: 8, height: 8, maxColors: 2,
    constraints: [{ kind: 'lock-empty' as const, cellIndices: [0] }], sourceFeatures: [feature], optimization: { iterations: 4, maxEvaluations: 1000 } };
  const actual = generatePattern(request), manual = generatePattern({ ...request, sourceFeatures: [{ ...feature, id: 'manual', label: '人工区域' }] });
  assert.deepEqual(actual.cells, manual.cells); assert.equal(actual.cells[0], null); assert.ok(actual.diagnostics.usedColors <= 2);
  assert.equal(buildBom(actual).totalBeads, actual.cells.filter(c => c !== null).length);
  assert.deepEqual(actual, generatePattern(request));
});

test('scene record and accepted masks survive project export and no-source reopening while malformed records fail import', () => {
  const { image, analysis, palette } = fixture(), project = withCells(createProject(2, 2), ['mard-h7', null, null, null]);
  project.beadify = { schemaVersion: 1, paletteSnapshot: palette, lastGeneration: { method: 'optimized', inputRevision: 1, configHash: null }, sceneAnalysis: analysis,
    generationSettings: { method: 'optimized', width: 8, height: 8, maxColors: 2, sourceFeatures: [sceneFeature(image, analysis, analysis.regions[1], palette).feature] } };
  const saved = normalizeProject(JSON.parse(serializeProject(project)));
  assert.deepEqual(saved.beadify?.sceneAnalysis, analysis); assert.deepEqual(saved.beadify?.generationSettings, project.beadify.generationSettings); assert.deepEqual(saved.cells, project.cells);
  const bad = JSON.parse(serializeProject(project)); bad.beadify.sceneAnalysis.regions[0].box[0] += 1;
  assert.throws(() => normalizeProject(bad), /校验/);
});

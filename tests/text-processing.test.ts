import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BeadPattern, GenerationRequest, TextAnalysis } from '../src/beadify/contracts';
import { applyColorChange, buildBom, createEnergyProblem, createEnergyState, createSourceRaster, energyDelta, evaluateEnergy, generatePattern, generateTextCandidate, isFeasible, prepareColors, validatePattern } from '../src/beadify/core';
import { createTextAnalysis } from '../src/beadify/core/text-analysis';
import { extractTextEvidence, maskRuns } from '../src/beadify/core/text-extraction';
import { buildTextSystem, textAdmissible } from '../src/beadify/core/text-system';
import { hashJson, sha256 } from '../src/beadify/core/hash';
import { inspectCells, inspectConnectivity } from '../src/beadify/core/grid';
import { createTextFixtures, textFixtureRequest } from '../benchmark/text-fixtures';
import { scoreTextFixture } from '../benchmark/text-score';

function fixture() {
  const width = 96, height = 64, data = new Uint8ClampedArray(width * height * 4), ink: number[] = [], background: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, black = x >= 39 && x < 42 && y >= 12 && y < 52;
    data.set(black ? [25, 25, 25, 255] : [250, 250, 250, 255], i * 4);
    if (x >= 24 && x < 56 && y >= 8 && y < 56) (black ? ink : background).push(i);
  }
  const request: GenerationRequest = { schemaVersion: 1, revision: 7, image: { width, height, data }, width: 12, height: 8, method: 'optimized', maxColors: 2,
    palette: { id: 'text-test', version: '1', source: 'Original diagnostic', license: 'CC0-1.0', approximate: false,
      colors: [{ id: 'B', code: 'B', brand: 'test', series: 'text', srgb8: [25, 25, 25] }, { id: 'W', code: 'W', brand: 'test', series: 'text', srgb8: [250, 250, 250] }] },
    optimization: { iterations: 3, maxEvaluations: 5000, restarts: 1 } };
  const analysis = createTextAnalysis({ schemaVersion: 1, kind: 'text-analysis', source: { width, height, rgbaHash: sha256(data), analysisWidth: width, analysisHeight: height,
    sourceToAnalysis: [1, 0, 0, 0, 1, 0, 0, 0, 1], analysisToSource: [1, 0, 0, 0, 1, 0, 0, 0, 1], preprocessingHash: hashJson({}) },
    provider: { kind: 'fixture', id: 'text-test', version: '1', modelHash: null, configHash: hashJson({}), promptHash: null, device: 'none' },
    regions: [{ id: 'line', parentId: null, polygon: [[24, 8], [56, 8], [56, 56], [24, 56]], granularity: 'line', role: 'text', status: 'verified', transcription: 'I', detectionScore: null, recognitionScore: null, alignment: 'manual', readingOrder: 0, angle: 0 }],
    evidence: [{ id: 'ink', regionId: 'line', kind: 'ink', origin: 'fixture', status: 'verified', runs: maskRuns(ink) }, { id: 'background', regionId: 'line', kind: 'background', origin: 'fixture', status: 'verified', runs: maskRuns(background) }], relations: [], suggestions: [], corrections: [], rawOutput: '' });
  const generated = generatePattern(request), cells = generated.cells.map(() => 'W'); cells[0] = 'B';
  const { optimization: _optimization, ...diagnostics } = generated.diagnostics;
  const base: BeadPattern = { ...generated, cells, diagnostics: { ...diagnostics, ...inspectCells(cells, 12, 8), ...inspectConnectivity(cells, 12, 8) } };
  validatePattern(base);
  return { request, analysis, base };
}

test('whole text proposal restores an erased source stroke while keeping external edits and the color budget', () => {
  const { request, analysis, base } = fixture(), before = JSON.stringify(base);
  const result = generateTextCandidate(request, analysis, base);
  assert.equal(result.status, 'CANDIDATE'); assert.ok(result.changedCells.length > 0);
  assert.equal(result.pattern.cells[0], 'B'); assert.equal(JSON.stringify(base), before);
  for (let i = 0; i < base.cells.length; i++) if (!result.writableCells.includes(i)) assert.equal(result.pattern.cells[i], base.cells[i]);
  assert.equal(result.health[0].before.missing, 1); assert.equal(result.health[0].after.missing, 0); assert.equal(result.health[0].after.fragments, 0);
  const optimization = result.pattern.diagnostics.optimization!;
  assert.ok(optimization.finalEnergy < optimization.initialEnergy); assert.ok(optimization.evaluations <= 5000);
  assert.equal(buildBom(result.pattern).totalBeads, 96); validatePattern(result.pattern);
  assert.deepEqual(generateTextCandidate(request, analysis, base), result);
});

test('text full energy and single-cell deltas agree, including protected singleton changes', () => {
  const { request, analysis, base } = fixture(), colors = prepareColors(request.palette.colors), target = createSourceRaster(request).cells;
  const system = buildTextSystem(request, analysis, base, colors), problem = createEnergyProblem(request, target, colors, undefined, system);
  const state = createEnergyState(problem, base.cells);
  let checked = 0;
  for (const i of system.writable) for (const id of ['B', 'W']) {
    const before = evaluateEnergy(problem, state.cells).total, delta = energyDelta(problem, state, i, id), candidate = [...state.cells]; candidate[i] = id;
    if (Number.isFinite(delta)) {
      assert.ok(Math.abs(evaluateEnergy(problem, candidate).total - before - delta) < 1e-9); assert.ok(isFeasible(problem, candidate)); checked++;
      if (delta < 0) { applyColorChange(problem, state, i, id); assert.deepEqual(state.textCosts, createEnergyState(problem, state.cells).textCosts); }
    }
  }
  assert.ok(checked > 10);
});

test('provider/transcription changes leave core text output identical and unknown containers cannot paint', () => {
  const { request, analysis, base } = fixture(), first = generateTextCandidate(request, analysis, base);
  const { cacheKey: _cache, contentHash: _hash, ...draft } = analysis;
  for (const kind of ['manual', 'ocr', 'vlm'] as const) {
    const changed = createTextAnalysis({ ...draft, provider: { ...draft.provider, kind, id: `different-${kind}`, modelHash: hashJson('weights') }, regions: draft.regions.map(r => ({ ...r, transcription: 'not a source glyph' })) });
    assert.deepEqual(generateTextCandidate(request, changed, base).pattern, first.pattern);
  }
  const unknown = createTextAnalysis({ ...draft, evidence: [], regions: draft.regions.map(r => ({ ...r, status: 'unknown' })) });
  assert.deepEqual(generateTextCandidate(request, unknown, base).pattern, base);
});

test('hard color/empty locks and required colors take precedence over text evidence', () => {
  const { request, analysis } = fixture();
  request.constraints = [{ kind: 'lock-empty', cellIndices: [29] }, { kind: 'lock-color', cellIndices: [41], colorId: 'W' }]; request.requiredColors = ['B'];
  const base = generatePattern(request), result = generateTextCandidate(request, analysis, base);
  assert.equal(result.pattern.cells[29], null); assert.equal(result.pattern.cells[41], 'W'); assert.ok(result.pattern.cells.includes('B'));
  assert.throws(() => generateTextCandidate({ ...request, preparedRaster: createSourceRaster(request) }, analysis), /original image|cached/);
});

test('source layer extraction preserves disconnected source components and refuses unknown classification', () => {
  const { request, analysis } = fixture(), { cacheKey: _key, contentHash: _hash, ...draft } = analysis;
  const marked = createTextAnalysis({ ...draft, evidence: [] }), result = extractTextEvidence(marked, request.image);
  assert.equal(result.diagnostics[0].status, 'SOURCE_LAYERS_EXTRACTED'); assert.equal(result.analysis.evidence.length, 2);
  assert.deepEqual(result.analysis.evidence[0].runs, analysis.evidence[0].runs);
  const unknown = createTextAnalysis({ ...draft, evidence: [], regions: draft.regions.map(r => ({ ...r, status: 'unknown', recognitionScore: null })) });
  assert.equal(extractTextEvidence(unknown, request.image).analysis.evidence.length, 0);
  const changed = { ...request.image, data: Uint8ClampedArray.from(request.image.data) }; changed.data[0]++;
  assert.throws(() => extractTextEvidence(marked, changed), /matching original/);
  assert.deepEqual(extractTextEvidence(analysis, request.image).analysis.evidence, analysis.evidence);
});

test('antialiased source/background separation admits its own seed and imported regions cannot trim supported H branches', () => {
  const fixtures = createTextFixtures();
  for (const id of ['disconnected-han', 'subgrid-thin-latin']) {
    const fixture = fixtures.find(f => f.id === id)!, request = textFixtureRequest(fixture.image, 40), base = generatePattern(request);
    const oracle: TextAnalysis = JSON.parse(readFileSync(`benchmark/text/interfaces-v1/${id}.analysis.json`, 'utf8'));
    const system = buildTextSystem(request, oracle, base, prepareColors(request.palette.colors));
    assert.ok(textAdmissible(system, base.cells));
    if (id === 'subgrid-thin-latin') {
      const raw = JSON.parse(readFileSync('tests/fixtures/imported-text-region.json', 'utf8'));
      const analysis = extractTextEvidence(createTextAnalysis(raw.draft), fixture.image).analysis;
      const candidate = generateTextCandidate(request, analysis, base);
      assert.ok(scoreTextFixture(fixture, candidate.pattern)!.missingLandmarks <= scoreTextFixture(fixture, base)!.missingLandmarks);
    }
  }
});

test('source masks cannot resurrect manually removed ink; optimizer configuration affects identity', () => {
  const { request, analysis, base } = fixture();
  const changed = generateTextCandidate(request, analysis, base);
  const another = generateTextCandidate({ ...request, optimization: { ...request.optimization, maxEvaluations: 4000 } }, analysis, base);
  assert.notEqual(changed.pattern.configHash, another.pattern.configHash);
  assert.throws(() => generateTextCandidate({ ...request, phase: [.2, 0] }, analysis, base), /layout or phase changed/);
  const mask = Array(request.image.width * request.image.height).fill(0);
  for (const [start, length] of analysis.evidence[0].runs) for (let i = start; i < start + length; i++) mask[i] = 2;
  const removed = { ...request, preprocessing: { mask } }, ordinary = generatePattern(removed);
  assert.deepEqual(generateTextCandidate(removed, analysis, ordinary).pattern, ordinary);
});

test('text cache identity uses palette inputs rather than derived floating-point colors', () => {
  const { request, analysis, base } = fixture();
  const colors = prepareColors(request.palette.colors);
  const expected = buildTextSystem(request, analysis, base, colors).hash;
  const rounded = colors.map(color => ({ ...color, oklab: { ...color.oklab, L: color.oklab.L + Number.EPSILON } }));
  assert.equal(buildTextSystem(request, analysis, base, rounded).hash, expected);
  const changed = structuredClone(request);
  changed.palette.colors[0].srgb8[0] = (changed.palette.colors[0].srgb8[0] + 1) % 256;
  assert.notEqual(buildTextSystem(changed, analysis, base, prepareColors(changed.palette.colors)).hash, expected);
});

test('a subgrid source hole freezes its footprint and neighbors rather than inventing a larger hole', () => {
  const { request, analysis, base } = fixture(), pixel = 30 * request.image.width + 40;
  request.image.data[pixel * 4] = request.image.data[pixel * 4 + 1] = request.image.data[pixel * 4 + 2] = 250;
  const { cacheKey: _key, contentHash: _hash, ...draft } = analysis;
  const indices = (e: TextAnalysis['evidence'][number]) => e.runs.flatMap(([start, length]) => Array.from({ length }, (_, i) => start + i));
  const source = createTextAnalysis({ ...draft, source: { ...draft.source, rgbaHash: sha256(request.image.data) }, evidence: [
    { ...draft.evidence[0], runs: maskRuns(indices(draft.evidence[0]).filter(i => i !== pixel)) },
    { ...draft.evidence[1], runs: maskRuns([...indices(draft.evidence[1]), pixel]) },
  ] });
  const system = buildTextSystem(request, source, base, prepareColors(request.palette.colors));
  assert.ok(system.diagnostics.some(d => (d.unexpressibleParts ?? 0) > 0));
  for (const y of [2, 3, 4]) for (const x of [4, 5, 6]) assert.ok(!system.writable.has(y * 12 + x));
});

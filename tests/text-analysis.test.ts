import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import schema from '../src/beadify/contracts/schema.json';
import type { RgbaImage, TextAnalysis, TextProvider, TextSource } from '../src/beadify/contracts';
import { createTextAnalysis, projectTextEvidence, textAnalysisCacheKey, textCoreEvidenceHash, transformTextPoint, validateTextAnalysis } from '../src/beadify/core/text-analysis';
import { hashJson, sha256 } from '../src/beadify/core/hash';

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const image: RgbaImage = { width: 8, height: 4, data: new Uint8ClampedArray(Array.from({ length: 32 }, () => [20, 30, 40, 255]).flat()) };
const source: TextSource = { rgbaHash: sha256(image.data), width: 8, height: 4, analysisWidth: 8, analysisHeight: 4, sourceToAnalysis: identity, analysisToSource: identity, preprocessingHash: hashJson({ exif: 'upright' }) };
const provider: TextProvider = { kind: 'manual', id: 'source-check', version: '1', modelHash: null, configHash: hashJson({}), promptHash: null, device: 'none' };
function draft(): Omit<TextAnalysis, 'cacheKey' | 'contentHash'> {
  return { schemaVersion: 1, kind: 'text-analysis', source: structuredClone(source), provider: structuredClone(provider),
    regions: [{ id: 'line', parentId: null, polygon: [[0, 0], [8, 0], [8, 4], [0, 4]], granularity: 'line', role: 'text', status: 'verified', transcription: '小',
      detectionScore: null, recognitionScore: null, alignment: 'manual', readingOrder: null, angle: null }], suggestions: [], corrections: [], relations: [], rawOutput: '',
    evidence: [{ id: 'stroke', regionId: 'line', kind: 'ink', status: 'verified', origin: 'manual', runs: [[11, 1], [19, 1]] },
      { id: 'gap', regionId: 'line', kind: 'background', status: 'verified', origin: 'manual', runs: [[12, 1], [20, 1]] }] };
}
const parseSchema = new Ajv({ strict: false }).compile(schema);

test('text records round trip through generated schema; None and empty OCR detections remain distinct', () => {
  const record = createTextAnalysis(draft());
  assert.ok(parseSchema(record), JSON.stringify(parseSchema.errors)); validateTextAnalysis(JSON.parse(JSON.stringify(record)));
  const none = draft(); none.provider.kind = 'none'; none.regions = []; none.evidence = [];
  const empty = createTextAnalysis(none); assert.ok(parseSchema(empty)); assert.deepEqual(projectTextEvidence(empty, image, { width: 8, height: 4 }).writableCells, []);
  const ocr = draft(); ocr.provider = { ...provider, kind: 'ocr', modelHash: hashJson('weights') }; ocr.evidence = [];
  ocr.regions[0] = { ...ocr.regions[0], transcription: '', status: 'unknown', detectionScore: .95, recognitionScore: .01, alignment: 'recognition-estimate' };
  const detected = createTextAnalysis(ocr);
  assert.equal(detected.regions.length, 1); assert.equal(detected.regions[0].transcription, '');
  assert.deepEqual(projectTextEvidence(detected, image, { width: 8, height: 4 }).writableCells, []);
});

test('crop and perspective transforms round trip; singular, horizon and wrong inverses are rejected', () => {
  const value = draft();
  value.source.analysisWidth = 12; value.source.analysisHeight = 8;
  value.source.sourceToAnalysis = [2, 0, -4, 0, 2, 0, 0, 0, 1]; value.source.analysisToSource = [.5, 0, 2, 0, .5, 0, 0, 0, 1];
  const record = createTextAnalysis(value);
  assert.deepEqual(transformTextPoint(record.source.analysisToSource, transformTextPoint(record.source.sourceToAnalysis, [5, 2])), [5, 2]);
  const forward = [1, 0, 0, 0, 1, 0, .02, .01, 1], inverse = [1, 0, 0, 0, 1, 0, -.02, -.01, 1];
  value.source.sourceToAnalysis = forward; value.source.analysisToSource = inverse; createTextAnalysis(value);
  for (const point of [[0, 0], [8, 4], [3.2, 1.7]]) {
    const p = transformTextPoint(inverse, transformTextPoint(forward, point)); assert.ok(p.every((v, i) => Math.abs(v - point[i]) < 1e-10));
  }
  value.source.analysisToSource = identity; assert.throws(() => createTextAnalysis(value), /not inverses/);
  value.source.sourceToAnalysis = [1, 0, 0, 0, 1, 0, -.25, 0, 1]; value.source.analysisToSource = [1, 0, 0, 0, 1, 0, .25, 0, 1];
  assert.throws(() => createTextAnalysis(value), /horizon/);
  assert.throws(() => transformTextPoint([0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1]), /horizon/);
});

test('cache identity covers source, transform, preprocessing, model, config and prompt, while projection covers grid', () => {
  const record = createTextAnalysis(draft());
  for (const mutate of [
    (v: ReturnType<typeof draft>) => v.source.rgbaHash = hashJson('another image'),
    (v: ReturnType<typeof draft>) => v.source.preprocessingHash = hashJson('contrast'),
    (v: ReturnType<typeof draft>) => v.source.analysisWidth = 7,
    (v: ReturnType<typeof draft>) => v.provider.version = '2',
    (v: ReturnType<typeof draft>) => v.provider.modelHash = hashJson('new weights'),
    (v: ReturnType<typeof draft>) => v.provider.configHash = hashJson('different config'),
    (v: ReturnType<typeof draft>) => v.provider.promptHash = hashJson('different prompt'),
  ]) { const v = draft(); mutate(v); assert.notEqual(textAnalysisCacheKey(v.source, v.provider), record.cacheKey); }
  const small = projectTextEvidence(record, image, { width: 4, height: 2 }), large = projectTextEvidence(record, image, { width: 8, height: 4 });
  assert.notEqual(small.projectionHash, large.projectionHash); assert.equal(small.coreHash, large.coreHash);
  const stale = structuredClone(record); stale.source.preprocessingHash = hashJson('edited'); assert.throws(() => validateTextAnalysis(stale), /stale/);
  const damaged = structuredClone(record); damaged.regions[0].transcription = '大'; assert.throws(() => validateTextAnalysis(damaged), /integrity/);
});

test('verified evidence is provider independent; duplicate records and corrected strings cannot increase source mass', () => {
  const reference = createTextAnalysis(draft()), expected = projectTextEvidence(reference, image, { width: 8, height: 4 });
  for (const kind of ['fixture', 'manual', 'ocr', 'vlm'] as const) {
    const v = draft(); v.provider.kind = kind; v.provider.modelHash = hashJson('pinned'); v.provider.device = 'different-device';
    v.regions[0].transcription = 'unreliable recognition'; v.corrections = [{ regionId: 'line', transcription: 'corrected text', origin: 'manual' }];
    v.evidence.push({ ...structuredClone(v.evidence[0]), id: 'duplicate' });
    const record = createTextAnalysis(v);
    assert.equal(textCoreEvidenceHash(record), textCoreEvidenceHash(reference));
    assert.deepEqual(projectTextEvidence(record, image, { width: 8, height: 4 }), expected);
  }
});

test('projection keeps source crop, fractional phase, alpha occupancy and hard locks', () => {
  const record = createTextAnalysis(draft());
  const full = projectTextEvidence(record, image, { width: 8, height: 4, lockedCells: [11] });
  assert.deepEqual(full.writableCells, [12, 19, 20]);
  assert.deepEqual(full.coverage[0].cells, [{ index: 11, coverage: 1 }, { index: 19, coverage: 1 }]);
  const cropped = projectTextEvidence(record, image, { width: 4, height: 4, crop: [2, 0, 6, 4], phase: [.25, 0], lockedCells: [5] });
  assert.ok(!cropped.writableCells.includes(5));
  assert.deepEqual(cropped.coverage[0].cells, [{ index: 5, coverage: .75 }, { index: 6, coverage: .25 }, { index: 9, coverage: .75 }, { index: 10, coverage: .25 }]);
  const transparent = { ...image, data: Uint8ClampedArray.from(image.data) }; transparent.data[11 * 4 + 3] = 0; transparent.data[19 * 4 + 3] = 1;
  const v = draft(); v.source.rgbaHash = sha256(transparent.data);
  const result = projectTextEvidence(createTextAnalysis(v), transparent, { width: 8, height: 4 });
  assert.ok(!result.writableCells.includes(11)); assert.ok(!result.writableCells.includes(19));
  assert.throws(() => projectTextEvidence(record, transparent, { width: 8, height: 4 }), /must match/);
});

test('unknown evidence and VLM proposals stay diagnostic and do not paint the region container', () => {
  const v = draft(); v.regions[0].status = 'unknown'; v.evidence.forEach(e => e.status = 'unknown');
  v.suggestions = [{ provider: { ...provider, kind: 'vlm', modelHash: hashJson('weights') }, regionId: null,
    polygon: [[0, 0], [8, 0], [8, 4], [0, 4]], role: 'text', transcription: 'invented', reason: 'proposal requires source verification' }];
  const record = createTextAnalysis(v); assert.deepEqual(projectTextEvidence(record, image, { width: 8, height: 4 }).writableCells, []);
  v.suggestions[0].provider.promptHash = hashJson('new VLM prompt');
  assert.notEqual(createTextAnalysis(v).cacheKey, record.cacheKey);
  v.evidence[0].status = 'verified'; assert.throws(() => createTextAnalysis(v), /requires verified text/);
});

test('overlapping region containers are allowed but contradictory verified source roles fail', () => {
  const v = draft(); v.regions.push({ ...structuredClone(v.regions[0]), id: 'word', parentId: 'line', granularity: 'word' });
  createTextAnalysis(v);
  v.evidence[1].runs = [[11, 1]]; assert.throws(() => createTextAnalysis(v), /conflicting source roles/);
  v.evidence[1].kind = 'outline'; assert.throws(() => createTextAnalysis(v), /conflicting source roles/);
});

test('malformed, out-of-bounds and unsupported records are rejected before they reach the engine', () => {
  const cases: [string, (v: ReturnType<typeof draft>) => void][] = [
    ['out of bounds', v => v.regions[0].polygon[1][0] = 9],
    ['crossed polygon', v => v.regions[0].polygon = [[0, 0], [8, 4], [8, 0], [0, 4]]],
    ['duplicate point', v => v.regions[0].polygon[1] = [0, 0]],
    ['bad score', v => v.regions[0].recognitionScore = NaN],
    ['unknown parent', v => v.regions[0].parentId = 'missing'],
    ['cyclic parent', v => v.regions[0].parentId = 'line'],
    ['duplicate id', v => v.regions.push(structuredClone(v.regions[0]))],
    ['zero run', v => v.evidence[0].runs = [[1, 0]]],
    ['out of bounds run', v => v.evidence[0].runs = [[31, 2]]],
    ['overlapping runs', v => v.evidence[0].runs = [[11, 2], [12, 1]]],
    ['source outside region', v => v.regions[0].polygon = [[0, 0], [2, 0], [2, 2], [0, 2]]],
    ['invalid relation', v => v.relations = [{ kind: 'connected', status: 'verified', evidenceIds: ['stroke', 'missing'] }]],
    ['unknown relation support', v => { v.evidence[0].status = 'unknown'; v.relations = [{ kind: 'connected', status: 'verified', evidenceIds: ['stroke', 'gap'] }]; }],
    ['contradictory relations', v => v.relations = [{ kind: 'connected', status: 'verified', evidenceIds: ['stroke', 'gap'] }, { kind: 'separate', status: 'verified', evidenceIds: ['gap', 'stroke'] }]],
    ['transcription limit', v => v.regions[0].transcription = 'x'.repeat(513)],
    ['output limit', v => v.rawOutput = 'x'.repeat(32769)],
    ['None with regions', v => v.provider.kind = 'none'],
    ['unpinned model', v => v.provider.kind = 'ocr'],
  ];
  for (const [name, mutate] of cases) { const v = draft(); mutate(v); assert.throws(() => createTextAnalysis(v), undefined, name); }
  const record = createTextAnalysis(draft());
  assert.throws(() => validateTextAnalysis({ ...record, unsupported: true }), /unsupported field/);
  assert.throws(() => validateTextAnalysis({ ...record, regions: Array(129).fill(record.regions[0]) }), /128 entries/);
  assert.throws(() => validateTextAnalysis({ ...record, evidence: [{ ...record.evidence[0], runs: Array(16385).fill([0, 1]) }] }), /16384 entries/);
});

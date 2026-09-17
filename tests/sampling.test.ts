import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePattern, linearToSrgb8, loadPalette, oklabToLinear, sampleImage, sampleStructuredImage, validatePattern } from '../src/beadify/core/index';
import { patternGeometry } from '../src/beadify/core/validation';
import type { GenerationRequest, RgbaImage } from '../src/beadify/contracts';
import { indexSourceComponents } from '../src/beadify/core/source-components';
import { sourceRegionEvidence } from '../src/beadify/core/source-evidence';
import { indexSourceStrokes } from '../src/beadify/core/source-lines';
import { createDetailFixtures } from '../benchmark/detail-fixtures';
import { createFixtures as createNextFixtures } from '../benchmark/g2-next-fixtures';

const palette = loadPalette({ id: 'test', version: '1', source: 'Original synthetic fixtures', license: 'CC0-1.0', approximate: false, colors: [['B', 0], ['G', 188], ['W', 255]].map(([id, value]) => ({ id, code: id, brand: 'test', series: 'test', srgb8: [value, value, value] })) });
const solid = (width: number, height: number, rgb: number[], alpha = 255): RgbaImage => ({ width, height, data: Array.from({ length: width * height }, () => [...rgb, alpha]).flat() });
const req = (image: RgbaImage, extra: Partial<GenerationRequest> = {}): GenerationRequest => ({ schemaVersion: 1, revision: 1, image, width: image.width, height: image.height, method: 'dominant', palette, maxColors: 3, ...extra });

test('multimode sampling preserves constant color and alpha decisions across several grid phases', () => {
  for (const phase of [-0.4, -0.15, 0, 0.2, 0.45]) for (const alpha of [0, 127, 128, 255]) {
    const image = solid(9, 9, [38, 121, 203], alpha);
    const geometry = patternGeometry(9, 9, 3, 3, undefined, [phase, phase]);
    const area = sampleImage(image, 3, 3, geometry, 'area'), structured = sampleStructuredImage(image, 3, 3, geometry);
    assert.deepEqual(structured.map(Boolean), area.map(Boolean));
    for (const cell of structured) if (cell) {
      assert.deepEqual(linearToSrgb8(oklabToLinear(cell.representative)), [38, 121, 203]);
      assert.equal(cell.modes.length, 1);
      assert.ok(Math.abs(cell.modes[0].weight - 1) < 1e-12);
    }
  }
});

test('high contrast regions keep separate modes and avoid dirty average as the only candidate', () => {
  const image: RgbaImage = { width: 2, height: 2, data: [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255] };
  const geometry = patternGeometry(2, 2, 1, 1);
  const cell = sampleStructuredImage(image, 1, 1, geometry)[0]!;
  assert.deepEqual(cell.modes.map(mode => linearToSrgb8(oklabToLinear(mode.color))), [[0, 0, 0], [255, 255, 255]]);
  assert.deepEqual(cell.modes.map(mode => mode.weight), [0.5, 0.5]);
  assert.deepEqual(linearToSrgb8(oklabToLinear(cell.mean)), [188, 188, 188]);
  assert.deepEqual(linearToSrgb8(oklabToLinear(cell.representative)), [0, 0, 0]);
  assert.equal(generatePattern(req(image, { width: 1, height: 1, style: 'accurate' })).cells[0], 'G');
  assert.equal(generatePattern(req(image, { width: 1, height: 1, style: 'clean' })).cells[0], 'B');
});

test('fourth-bin minority highlight survives mode compression and all mode weights remain normalized', () => {
  const values = [...Array(10).fill(0), ...Array(6).fill(20), ...Array(5).fill(40), ...Array(3).fill(255), 65];
  const image: RgbaImage = { width: 5, height: 5, data: values.flatMap(value => [value, value, value, 255]) };
  const cell = sampleStructuredImage(image, 1, 1, patternGeometry(5, 5, 1, 1))[0]!;
  assert.ok(cell.modes.some(mode => linearToSrgb8(oklabToLinear(mode.color))[0] === 255));
  assert.ok(Math.abs(cell.modes.reduce((sum, mode) => sum + mode.weight, 0) - 1) < 1e-12);
  assert.deepEqual(sampleStructuredImage(image, 1, 1, patternGeometry(5, 5, 1, 1)), [cell]);
});

test('hidden RGB never becomes a structural mode and alpha threshold still includes exact half coverage', () => {
  const image: RgbaImage = { width: 2, height: 2, data: [0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 200, 10, 255, 0] };
  const cell = sampleStructuredImage(image, 1, 1, patternGeometry(2, 2, 1, 1))[0]!;
  assert.equal(cell.coverage, 0.5);
  assert.equal(cell.modes.length, 1);
  assert.deepEqual(linearToSrgb8(oklabToLinear(cell.modes[0].color)), [0, 0, 0]);
});

test('pixel input explicitly bypasses multimode denoising and equals center nearest sampling', () => {
  const image: RgbaImage = { width: 4, height: 4, data: Array.from({ length: 16 }, (_, index) => [...(index % 3 === 0 ? [255, 255, 255] : [0, 0, 0]), 255]).flat() };
  for (const phase of [-0.3, 0, 0.3]) {
    const geometry = patternGeometry(4, 4, 2, 2, undefined, [phase, phase]);
    const target = sampleStructuredImage(image, 2, 2, geometry, 'pixel-input');
    assert.deepEqual(target.map(cell => cell?.representative ?? null), sampleImage(image, 2, 2, geometry, 'nearest'));
    assert.ok(target.every(cell => !cell || cell.modes.length === 1));
    assert.ok(target.every(cell => !cell || cell.modes.every(mode => mode.components === undefined && mode.compactSupport === undefined && mode.boundarySupport === undefined)));
  }
});

test('crop and phase geometry maps original coordinates consistently through generation and import', () => {
  const image = solid(8, 6, [0, 0, 0]);
  const request = req(image, { width: 4, height: 4, preprocessing: { crop: [2, 1, 6, 5] }, phase: [0.2, -0.1] });
  const result = generatePattern(request);
  validatePattern(result);
  assert.deepEqual(result.geometry.sourceToGrid, [1, 0, -1.8, 0, 1, -1.1, 0, 0, 1]);
  assert.deepEqual(result.geometry.crop, [2, 1, 6, 5]);
  const corrupt = structuredClone(result); corrupt.geometry.sourceToGrid[2] += 1;
  assert.throws(() => validatePattern(corrupt), /transform/);
  assert.notEqual(result.configHash, generatePattern({ ...request, phase: [0, 0] }).configHash);
  assert.notEqual(result.configHash, generatePattern({ ...request, preprocessing: { crop: [1, 1, 5, 5] } }).configHash);
});

test('original preprocessing mask is applied before structure sampling without mutating the source', () => {
  const image = solid(3, 1, [255, 255, 255]);
  const before = Array.from(image.data);
  const pattern = generatePattern(req(image, { preprocessing: { mask: [0, 2, 1], background: 'keep' } }));
  assert.deepEqual(pattern.cells, ['W', null, 'W']);
  assert.deepEqual(Array.from(image.data), before);
  validatePattern(pattern);
});

test('optional bilateral smoothing reduces low-contrast texture, preserves hard edges and never changes alpha', async () => {
  const { smoothImage } = await import('../src/beadify/core/sampling');
  const noisy = solid(3, 3, [100, 100, 100]);
  noisy.data[16] = 115; noisy.data[17] = 115; noisy.data[18] = 115;
  const smoothed = smoothImage(noisy);
  assert.ok(smoothed.data[16] < 115 && smoothed.data[16] > 100);
  assert.equal(noisy.data[16], 115);
  const edge: RgbaImage = { width: 3, height: 1, data: [0, 0, 0, 255, 255, 255, 255, 128, 128, 0, 255, 0] };
  const result = smoothImage(edge);
  assert.deepEqual(Array.from(result.data), edge.data);
  const flat = solid(3, 3, [50, 125, 210], 128);
  assert.deepEqual(Array.from(smoothImage(flat).data), flat.data);
});

test('smoothing is optional in generation and pixel-input explicitly bypasses it', () => {
  const image = solid(3, 3, [100, 100, 100]); image.data[16] = 130; image.data[17] = 130; image.data[18] = 130;
  const request = req(image, { method: 'optimized', style: 'pixel-input', preprocessing: { smoothing: true } });
  const skipped = generatePattern(request), plain = generatePattern({ ...request, preprocessing: { smoothing: false } });
  assert.deepEqual(skipped.cells, plain.cells);
  assert.ok(skipped.diagnostics.warnings.some(warning => warning.includes('bypasses optional smoothing')));
  assert.doesNotThrow(() => generatePattern({ ...request, style: 'clean' }));
  assert.throws(() => generatePattern({ ...request, preprocessing: { smoothing: 'yes' } } as unknown as GenerationRequest), /smoothing/);
});

test('raw source contrast remains inspectable without automatically protecting an isolated source speck', () => {
  const image = solid(4, 4, [0, 0, 0]); image.data[0] = 255; image.data[1] = 255; image.data[2] = 255;
  const cell = sampleStructuredImage(image, 1, 1, patternGeometry(4, 4, 1, 1))[0]!;
  assert.ok(cell.sourceEdge! > 0.9);
  assert.ok(cell.sourceContrast! > 0.9);
  assert.equal(cell.edgeReliability, 0);
  assert.equal(cell.edge, 0);
  assert.equal(cell.importance, 1);
  assert.deepEqual(linearToSrgb8(oklabToLinear(cell.representative)), [0, 0, 0]);
});

function markBlack(image: RgbaImage, indices: number[]): RgbaImage {
  for (const index of indices) for (let channel = 0; channel < 3; channel++) image.data[4 * index + channel] = 0;
  return image;
}
const blackMode = (cell: NonNullable<ReturnType<typeof sampleStructuredImage>[number]>) => cell.modes.find(mode => mode.color.L < 0.01)!;

test('original evidence and coherent minority candidates survive independently of filtered RGB', () => {
  const original = markBlack(solid(8, 8, [255, 255, 255]), Array.from({ length: 8 }, (_, x) => 3 * 8 + x));
  const filtered = solid(8, 8, [255, 255, 255]), geometry = patternGeometry(8, 8, 1, 1);
  const expected = sampleStructuredImage(original, 1, 1, geometry)[0]!;
  const dual = sampleStructuredImage(filtered, 1, 1, geometry, 'clean', { sourceImage: original })[0]!;
  const filteredOnly = sampleStructuredImage(filtered, 1, 1, geometry)[0]!;
  assert.deepEqual(dual.sourceMean, expected.sourceMean);
  assert.equal(dual.sourceEdge, expected.sourceEdge);
  assert.equal(dual.sourceContrast, expected.sourceContrast);
  assert.equal(dual.edgeReliability, 1);
  assert.equal(filteredOnly.sourceEdge, 0);
  assert.deepEqual(dual.mean, filteredOnly.mean, 'filtered color and original structure remain separate');
  assert.deepEqual(dual.representative, filteredOnly.representative, 'a source mode is a candidate, not an unconditional forced bead');
  assert.equal(blackMode(dual).weight, 0);
  assert.equal(blackMode(dual).sourceWeight, 0.125);
  assert.equal(blackMode(dual).structuralSupport, 1);
  assert.ok(Math.abs(dual.modes.reduce((sum, mode) => sum + mode.weight, 0) - 1) < 1e-12);
  assert.deepEqual(JSON.parse(JSON.stringify(dual)), dual, 'debug evidence uses only JSON-safe values');
});

test('the bilateral pass can attenuate a weak source line while the independent original gradient stays unchanged', async () => {
  const { smoothImage } = await import('../src/beadify/core/sampling');
  const original = solid(8, 8, [120, 120, 120]);
  for (let x = 0; x < 8; x++) for (let channel = 0; channel < 3; channel++) original.data[4 * (3 * 8 + x) + channel] = 90;
  const filtered = smoothImage(original), geometry = patternGeometry(8, 8, 1, 1);
  const originalCell = sampleStructuredImage(original, 1, 1, geometry)[0]!;
  const filteredCell = sampleStructuredImage(filtered, 1, 1, geometry)[0]!;
  const dual = sampleStructuredImage(filtered, 1, 1, geometry, 'clean', { sourceImage: original })[0]!;
  assert.ok(filteredCell.sourceEdge! < originalCell.sourceEdge!);
  assert.equal(dual.sourceEdge, originalCell.sourceEdge);
  assert.equal(dual.sourceContrast, originalCell.sourceContrast);
  assert.deepEqual(dual.sourceMean, originalCell.sourceMean);
  assert.deepEqual(dual.mean, filteredCell.mean);
  assert.notDeepEqual(dual.mean, dual.sourceMean);
});

test('equal color histograms distinguish a continuous narrow line from dispersed source noise', () => {
  const line = markBlack(solid(8, 8, [255, 255, 255]), Array.from({ length: 8 }, (_, x) => 3 * 8 + x));
  const noise = markBlack(solid(8, 8, [255, 255, 255]), [0, 2, 4, 6, 17, 19, 21, 23]);
  const geometry = patternGeometry(8, 8, 1, 1);
  const continuous = sampleStructuredImage(line, 1, 1, geometry)[0]!, dispersed = sampleStructuredImage(noise, 1, 1, geometry)[0]!;
  assert.deepEqual(continuous.mean, dispersed.mean);
  assert.deepEqual(continuous.modes.map(({ color, weight }) => ({ color, weight })), dispersed.modes.map(({ color, weight }) => ({ color, weight })));
  assert.equal(blackMode(continuous).structuralSupport, 1);
  assert.equal(blackMode(dispersed).structuralSupport, 0);
  assert.equal(continuous.edgeReliability, 1);
  assert.equal(dispersed.edgeReliability, 0);
  assert.ok(continuous.weightedMean!.L < dispersed.weightedMean!.L);
  assert.deepEqual(dispersed.weightedMean, dispersed.mean, 'dispersed high-contrast points receive no weighted-area amplification');
});

test('all sampling strategies remain explicit and edge weighting is a bounded optional operation', () => {
  const image = markBlack(solid(8, 8, [255, 255, 255]), Array.from({ length: 8 }, (_, x) => 3 * 8 + x));
  const geometry = patternGeometry(8, 8, 1, 1);
  const sample = (strategy: 'dominant' | 'mean' | 'weighted-area' | 'modes', sourceEdges = true) => sampleStructuredImage(image, 1, 1, geometry, 'clean', { strategy, sourceEdges })[0]!;
  const dominant = sample('dominant'), mean = sample('mean'), weighted = sample('weighted-area'), modes = sample('modes');
  assert.deepEqual(mean.representative, sampleImage(image, 1, 1, geometry, 'area')[0]);
  assert.deepEqual(dominant.representative, modes.representative);
  assert.ok(mean.representative.L > weighted.representative.L);
  const weightedLinear = oklabToLinear(weighted.representative).r;
  assert.ok(Math.abs(weightedLinear - 7 / 10) < 1e-6, 'the supported 1/8 black line is weighted at most 3× against white');
  const disabled = sample('weighted-area', false);
  assert.deepEqual(disabled.representative, mean.representative);
  assert.equal(disabled.edge, 0);
  assert.equal(disabled.importance, 1);
  assert.equal(disabled.sourceEdge, undefined);
  assert.ok(disabled.modes.every(mode => mode.structuralSupport === undefined));
});

test('horizontal and diagonal continuity evidence is stable across three scales and nine phases while dispersed controls stay unsupported', () => {
  let coherent = 0, dispersed = 0;
  for (const scale of [4, 8, 12]) for (const phaseX of [-0.35, 0, 0.35]) for (const phaseY of [-0.35, 0, 0.35]) {
    const side = scale * 3;
    const line = markBlack(solid(side, side, [255, 255, 255]), Array.from({ length: side }, (_, x) => Math.floor(side / 2) * side + x));
    const diagonal = markBlack(solid(side, side, [255, 255, 255]), Array.from({ length: side }, (_, x) => x * side + x));
    const noise = markBlack(solid(side, side, [255, 255, 255]), Array.from({ length: side }, (_, x) => (Math.floor(side / 2) - 3 + (x % 3) * 3) * side + x));
    const geometry = patternGeometry(side, side, 3, 3, undefined, [phaseX, phaseY]);
    const lineCell = sampleStructuredImage(line, 3, 3, geometry)[4]!;
    const diagonalCell = sampleStructuredImage(diagonal, 3, 3, geometry)[4]!;
    const noiseCell = sampleStructuredImage(noise, 3, 3, geometry)[4]!;
    assert.ok(blackMode(lineCell).structuralSupport! > 0.99);
    assert.equal(blackMode(noiseCell)?.structuralSupport ?? 0, 0);
    coherent += blackMode(diagonalCell)?.structuralSupport! >= 0.5 ? 1 : 0;
    dispersed += (blackMode(noiseCell)?.structuralSupport ?? 0) >= 0.5 ? 1 : 0;
    assert.deepEqual(sampleStructuredImage(line, 3, 3, geometry)[4], lineCell);
  }
  // A diagonal segment near opposite cell corners can be shorter than the
  // minimum span at some phase pairs. Record a quality floor, not a false claim
  // that all sub-grid features are representable at every alignment.
  assert.ok(coherent >= 15, `diagonal supported at ${coherent}/27 scale-phase combinations`);
  assert.equal(dispersed, 0);
});

test('fixed original pair contrast does not create grid edges between matching narrow-line cells', () => {
  const original = markBlack(solid(16, 8, [255, 255, 255]), Array.from({ length: 16 }, (_, x) => 3 * 16 + x));
  const cells = sampleStructuredImage(solid(16, 8, [200, 200, 200]), 2, 1, patternGeometry(16, 8, 2, 1), 'clean', { sourceImage: original });
  assert.equal(cells[0]!.sourceRightContrast, 0);
  assert.ok(cells[0]!.sourceEdge! > 0.9);
  assert.equal(cells[0]!.sourceRightReliability, 0, 'matching mixed means do not determine which supported mode a bead should represent');
  assert.equal(cells[1]!.sourceRightContrast, undefined);
});

test('dual-source sampling rejects mismatched prepared dimensions or alpha and Pixel Input samples the original', () => {
  const original = markBlack(solid(4, 4, [255, 255, 255]), [5, 7, 13, 15]), filtered = solid(4, 4, [120, 120, 120]);
  const geometry = patternGeometry(4, 4, 2, 2);
  const target = sampleStructuredImage(filtered, 2, 2, geometry, 'pixel-input', { sourceImage: original });
  assert.deepEqual(target.map(cell => cell?.representative ?? null), sampleImage(original, 2, 2, geometry, 'nearest'));
  assert.throws(() => sampleStructuredImage(filtered, 2, 2, geometry, 'clean', { sourceImage: solid(2, 8, [255, 255, 255]) }), /dimensions/);
  const alphaMismatch = solid(4, 4, [255, 255, 255]); alphaMismatch.data[3] = 0;
  assert.throws(() => sampleStructuredImage(filtered, 2, 2, geometry, 'clean', { sourceImage: alphaMismatch }), /alpha/);
});

function paintRect(image: RgbaImage, left: number, top: number, right: number, bottom: number, rgb: number[], alpha = 255): void {
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const at = 4 * (y * image.width + x);
    image.data[at] = rgb[0]; image.data[at + 1] = rgb[1]; image.data[at + 2] = rgb[2]; image.data[at + 3] = alpha;
  }
}

test('one original stroke keeps its identity and total source mass through grid boundaries and phase shifts', () => {
  const image = solid(32, 24, [255, 255, 255]); paintRect(image, 6, 11, 26, 13, [0, 0, 0]);
  const original = Array.from(image.data);
  const localCorner = sourceRegionEvidence(image, 0, 8, 8, 16)!.modes.find(mode => mode.color.L < .01)!;
  assert.ok(localCorner.structuralSupport < .5, 'the short corner fragment alone is insufficient continuity evidence');
  let originalId: number | undefined;
  for (const phase of [[0, 0], [.35, -.35], [-.35, .2]] as [number, number][]) {
    const target = sampleStructuredImage(image, 4, 3, patternGeometry(32, 24, 4, 3, undefined, phase));
    const fragments = target.flatMap((cell, index) => cell ? cell.modes.filter(mode => mode.color.L < .01).flatMap(mode => (mode.components ?? []).map(component => ({ index, ...component }))) : []);
    assert.ok(new Set(fragments.map(fragment => fragment.index)).size >= 3, 'the original stroke reaches several target cells');
    assert.equal(new Set(fragments.map(fragment => fragment.id)).size, 1);
    if (originalId === undefined) originalId = fragments[0].id;
    assert.ok(fragments.every(fragment => fragment.id === originalId && fragment.kind === 'stroke' && fragment.support > .5 && fragment.span > 1));
    assert.ok(Math.abs(fragments.reduce((sum, fragment) => sum + fragment.coverage, 0) - 40 / 64) < 1e-10, 'projection conserves the forty opaque source pixels');
  }
  const corner = sampleStructuredImage(image, 4, 3, patternGeometry(32, 24, 4, 3))[4]!;
  assert.ok(blackMode(corner).boundarySupport! > .5, 'the same fragment gains evidence from its continuation outside this cell');
  assert.deepEqual(Array.from(image.data), original);
});

test('a rare compact mark differs from repeated connected clusters even with an identical local color histogram', () => {
  const rare = solid(48, 32, [255, 255, 255]), repeated = solid(48, 32, [255, 255, 255]);
  paintRect(rare, 2, 2, 6, 6, [0, 0, 0]);
  for (const [x, y] of [[2, 2], [18, 2], [34, 2], [2, 18], [18, 18], [34, 18]]) paintRect(repeated, x, y, x + 4, y + 4, [0, 0, 0]);
  const geometry = patternGeometry(48, 32, 6, 4);
  const one = sampleStructuredImage(rare, 6, 4, geometry)[0]!, many = sampleStructuredImage(repeated, 6, 4, geometry)[0]!;
  assert.deepEqual(one.modes.map(({ color, weight }) => ({ color, weight })), many.modes.map(({ color, weight }) => ({ color, weight })));
  assert.ok(blackMode(one).compactSupport! > .5);
  assert.ok(blackMode(one).components?.some(component => component.kind === 'compact'));
  assert.ok(blackMode(many).compactSupport! < .5);
  assert.ok(blackMode(many).structuralSupport! < .5);
  assert.equal(blackMode(many).components?.length ?? 0, 0, 'repeated clusters do not gain automatic component appearance evidence');
});

test('one- and two-pixel specks do not inherit a later large component identity of the same color', () => {
  const image = solid(48, 32, [255, 255, 255]);
  paintRect(image, 2, 2, 4, 3, [0, 0, 0]); paintRect(image, 12, 12, 13, 13, [0, 0, 0]); paintRect(image, 26, 18, 30, 22, [0, 0, 0]);
  const target = sampleStructuredImage(image, 6, 4, patternGeometry(48, 32, 6, 4));
  for (const index of [0, 7]) {
    const mode = blackMode(target[index]!);
    assert.ok(mode.sourceWeight! > 0, 'small pixels remain honest color evidence');
    assert.equal(mode.structuralSupport, 0);
    assert.equal(mode.components?.length ?? 0, 0);
  }
  assert.ok(blackMode(target[15]!).components?.some(component => component.kind === 'compact'));
  const indexed = indexSourceComponents(image, 1 / 8);
  assert.ok(indexed.labels[2 * image.width + 2] < 0 && indexed.labels[12 * image.width + 12] < 0);
  assert.ok(indexed.labels[18 * image.width + 26] >= 0);
});

test('an almost transparent bridge affects color coverage without joining two source specks into a stroke', () => {
  const make = (alpha: number) => {
    const image = solid(16, 8, [255, 255, 255]);
    paintRect(image, 2, 3, 4, 4, [0, 0, 0]); paintRect(image, 10, 3, 12, 4, [0, 0, 0]);
    paintRect(image, 4, 3, 10, 4, [0, 0, 0], alpha);
    return image;
  };
  const geometry = patternGeometry(16, 8, 2, 1);
  const transparent = sampleStructuredImage(make(0), 2, 1, geometry);
  const faint = sampleStructuredImage(make(1), 2, 1, geometry);
  assert.ok(faint[0]!.coverage > transparent[0]!.coverage);
  assert.ok(blackMode(faint[0]!).sourceWeight! > blackMode(transparent[0]!).sourceWeight!);
  for (const alpha of [0, 1, 127]) {
    const image = make(alpha), target = sampleStructuredImage(image, 2, 1, geometry);
    assert.deepEqual(target.map(cell => cell!.mean), sampleImage(image, 2, 1, geometry, 'area'));
    for (const cell of target) {
      const mode = blackMode(cell!);
      assert.equal(mode.structuralSupport, 0, `alpha=${alpha} must not join the two opaque source specks`);
      assert.equal(mode.components?.length ?? 0, 0);
    }
  }
  const visible = sampleStructuredImage(make(128), 2, 1, geometry);
  const strokes = visible.flatMap(cell => blackMode(cell!).components ?? []);
  assert.ok(strokes.length >= 2 && strokes.every(component => component.kind === 'stroke'));
  assert.equal(new Set(strokes.map(component => component.id)).size, 1, 'a sufficiently visible bridge supplies actual continuity');
});

test('compact contrast comes from the original local surround and ignores transparent surround RGB', () => {
  const yellow = [250, 235, 150], original = solid(32, 24, yellow);
  paintRect(original, 9, 9, 15, 15, [0, 0, 0]); paintRect(original, 10, 10, 14, 14, [255, 255, 255]);
  const filtered = solid(32, 24, yellow); paintRect(filtered, 10, 10, 14, 14, [255, 255, 255]);
  const geometry = patternGeometry(32, 24, 4, 3);
  const white = (cell: NonNullable<ReturnType<typeof sampleStructuredImage>[number]>) => cell.modes.find(mode => mode.color.L > .99)!;
  const originalCell = sampleStructuredImage(original, 4, 3, geometry)[5]!;
  const dualCell = sampleStructuredImage(filtered, 4, 3, geometry, 'clean', { sourceImage: original })[5]!;
  const filteredCell = sampleStructuredImage(filtered, 4, 3, geometry)[5]!;
  assert.ok(white(originalCell).sourceContrast! > .2, 'the dark local ring is stronger evidence than the bright dominant cell color');
  assert.equal(white(dualCell).sourceContrast, white(originalCell).sourceContrast);
  assert.deepEqual(white(dualCell).components, white(originalCell).components);
  assert.ok(white(filteredCell).sourceContrast! < .18);
  assert.deepEqual(dualCell.mean, filteredCell.mean, 'filtered colors do not redefine original context');
  const clearRing = structuredClone(original);
  for (let y = 9; y < 15; y++) for (let x = 9; x < 15; x++) if (x === 9 || x === 14 || y === 9 || y === 14) clearRing.data[4 * (y * clearRing.width + x) + 3] = 0;
  const hiddenMagenta = structuredClone(clearRing);
  for (let at = 0; at < hiddenMagenta.data.length; at += 4) if (hiddenMagenta.data[at + 3] === 0) { hiddenMagenta.data[at] = 255; hiddenMagenta.data[at + 1] = 0; hiddenMagenta.data[at + 2] = 255; }
  const clearTarget = sampleStructuredImage(clearRing, 4, 3, geometry);
  assert.ok(white(clearTarget[5]!).sourceContrast! < .18, 'removed ring pixels cannot manufacture a dark surround');
  assert.deepEqual(sampleStructuredImage(hiddenMagenta, 4, 3, geometry), clearTarget);
  const floating = solid(16, 16, [0, 0, 0], 0); paintRect(floating, 6, 6, 10, 10, [255, 255, 255]);
  const mark = indexSourceComponents(floating, 1 / 8).components.find(component => component.pixels === 16)!;
  assert.equal(mark.surroundContrast, 0, 'a wholly transparent surround supplies no color reference');
});

test('a continuously shaded original curve keeps one identity, both endpoints and conserved area across color bins', () => {
  const original = solid(64, 40, [245, 221, 145]);
  for (let x = 8; x < 56; x++) {
    const y = 18 + Math.round(4 * Math.sin((x - 8) / 47 * Math.PI)), grey = 25 + x - 8;
    paintRect(original, x, y, x + 1, y + 2, [grey, grey, grey]);
  }
  const indexed = indexSourceStrokes(original, 1 / 8), supported = indexed.strokes.filter(stroke => stroke.support > .5);
  assert.equal(supported.length, 1);
  assert.equal(supported[0].pixels.length, 96, 'the differently colored curve pixels belong to one original structure');
  assert.equal(supported[0].closed, false);
  const filtered = solid(64, 40, [245, 221, 145]);
  for (const phase of [[0, 0], [.35, -.35]] as [number, number][]) {
    const geometry = patternGeometry(64, 40, 8, 5, undefined, phase);
    const target = sampleStructuredImage(filtered, 8, 5, geometry, 'clean', { sourceImage: original });
    const disabled = sampleStructuredImage(filtered, 8, 5, geometry, 'clean', { sourceImage: original, crossBinStrokes: false });
    assert.deepEqual(target.map(cell => cell?.mean), disabled.map(cell => cell?.mean));
    assert.deepEqual(target.map(cell => cell?.coverage), disabled.map(cell => cell?.coverage));
    const refs = target.flatMap((cell, index) => {
      const components = new Map(cell?.modes.flatMap(mode => (mode.components ?? []).filter(component => component.endpointMask !== undefined).map(component => [component.id, component] as const)));
      return [...components.values()].map(component => ({ index, ...component }));
    });
    assert.equal(new Set(refs.map(component => component.id)).size, 1);
    assert.ok(new Set(refs.map(component => component.index)).size >= 6);
    assert.equal(refs.reduce((mask, component) => mask | component.endpointMask!, 0), 3);
    assert.ok(Math.abs(refs.reduce((sum, component) => sum + component.coverage, 0) - 96 / 64) < 1e-10);
    assert.ok(target.flatMap(cell => cell?.modes ?? []).filter(mode => mode.components?.some(component => component.endpointMask !== undefined)).every(mode => mode.weight === 0), 'geometry colors still come from the original after smoothing removes the curve');
    assert.ok(disabled.every(cell => cell?.modes.every(mode => mode.components?.every(component => component.endpointMask === undefined) ?? true) ?? true));
    assert.ok(target.every(cell => !cell || Math.abs(cell.modes.reduce((sum, mode) => sum + mode.weight, 0) - 1) < 1e-12));
  }
});

test('two-sided source ridges reject a smooth ramp and cannot chain through an unlimited change in stroke color', () => {
  const ramp = solid(64, 32, [0, 0, 0]);
  for (let x = 0; x < ramp.width; x++) paintRect(ramp, x, 0, x + 1, ramp.height, [90 + 2 * x, 90 + 2 * x, 90 + 2 * x]);
  assert.equal(indexSourceStrokes(ramp, 1 / 8).strokes.filter(stroke => stroke.support > .5).length, 0);
  const changing = solid(64, 32, [255, 255, 255]);
  for (let x = 8; x < 56; x++) {
    const grey = Math.round(20 + 210 * (x - 8) / 47);
    paintRect(changing, x, 15, x + 1, 17, [grey, grey, grey]);
  }
  const components = indexSourceStrokes(changing, 1 / 8).strokes;
  assert.ok(components.length > 0, 'locally coherent segments are still source evidence');
  assert.ok(components.every(stroke => stroke.right - stroke.left < 32), 'small neighboring differences never join the near-black and near-white ends into one canonical color');
});

test('a closed source stroke requires an opaque contrasting hole, and supplies no fabricated endpoints', () => {
  const ring = solid(48, 48, [245, 221, 145]);
  for (let y = 0; y < ring.height; y++) for (let x = 0; x < ring.width; x++) {
    const radius = Math.hypot(x - 23.5, y - 23.5);
    if (radius < 13) paintRect(ring, x, y, x + 1, y + 1, radius < 10 ? [250, 250, 250] : [30, 30, 30]);
  }
  const strokes = indexSourceStrokes(ring, 1 / 8).strokes.filter(stroke => stroke.support > .5);
  assert.equal(strokes.filter(stroke => stroke.closed).length, 1);
  const target = sampleStructuredImage(ring, 6, 6, patternGeometry(48, 48, 6, 6));
  const closed = target.flatMap(cell => cell?.modes.flatMap(mode => (mode.components ?? []).filter(component => component.closed)) ?? []);
  assert.ok(closed.length > 4 && closed.every(component => component.kind === 'stroke' && component.endpointMask === 0));
  const open = structuredClone(ring); paintRect(open, 22, 10, 26, 16, [245, 221, 145]);
  assert.ok(indexSourceStrokes(open, 1 / 8).strokes.every(stroke => !stroke.closed), 'a visibly open ring does not prove enclosure');
  const transparentHole = structuredClone(ring);
  paintRect(transparentHole, 23, 23, 25, 25, [255, 0, 255], 0);
  assert.ok(indexSourceStrokes(transparentHole, 1 / 8).strokes.every(stroke => !stroke.closed), 'hidden interior RGB cannot prove an opaque contrasting region');
});

test('repeated diagonal texture remains unsupported when its endpoint pieces have different source areas', () => {
  for (const fixture of createDetailFixtures().filter(fixture => fixture.kind === 'diffuse-dark-noise')) {
    const { image, width, height, phase } = fixture.request;
    const indexed = indexSourceStrokes(image, 1 / fixture.sourcePixelsPerCell);
    assert.ok(indexed.strokes.length >= 3, 'this negative has actual connected short ribbons, not only isolated pixels');
    assert.ok(indexed.strokes.every(stroke => stroke.support <= .5), `${fixture.id}: half-sized endpoint ribbons must share the repeated texture evidence`);
    const target = sampleStructuredImage(image, width, height, patternGeometry(image.width, image.height, width, height, undefined, phase));
    assert.ok(target.every(cell => cell?.modes.every(mode => mode.components?.every(component => component.endpointMask === undefined) ?? true) ?? true), fixture.id);
  }
});

test('an enclosed filled accent larger than a tiny glint has region context without becoming a thin-line opportunity', () => {
  const original = solid(96, 80, [235, 230, 215]);
  paintRect(original, 26, 24, 62, 56, [45, 25, 20]);
  paintRect(original, 30, 28, 58, 52, [220, 100, 155]);
  const global = indexSourceComponents(original, 1 / 8);
  const evidence = sourceRegionEvidence(original, 32, 32, 40, 40, global)!;
  const pink = evidence.modes[0];
  assert.equal(pink.weight, 1);
  assert.equal(pink.compactSupport, 0);
  assert.equal(pink.contrast, 0, 'locally dominant color remains locally dominant; context is separately recorded');
  assert.ok(pink.components?.some(component => component.kind === 'region' && component.span > 3 && component.contrast! > .2));
  assert.ok(pink.components?.every(component => component.endpointMask === undefined && component.closed === undefined));
});

test('antialiased shaded arcs retain source-connected endpoint witnesses when exact tips fall below a bead footprint', () => {
  for (const fixture of createNextFixtures().filter(fixture => fixture.family === 'variable-curve')) {
    const { image, width, height, phase } = fixture.request, index = indexSourceStrokes(image, 1 / fixture.scale);
    const strokes = index.strokes.filter(stroke => stroke.support > .5);
    assert.equal(strokes.length, 1, fixture.id);
    const stroke = strokes[0];
    assert.ok(!stroke.closed && stroke.span > 7, 'tied local normals do not erase an otherwise connected elongated arc');
    for (const [end, pixels] of stroke.endpointNeighborhoods.entries()) {
      const tip = stroke.endpoints[end], tx = tip % image.width, ty = Math.floor(tip / image.width);
      assert.ok(pixels.length > 1 && pixels.includes(tip));
      assert.ok(pixels.every(pixel => index.labels[pixel] === index.labels[tip]), 'endpoint evidence never leaves the original accepted component');
      assert.ok(pixels.every(pixel => Math.hypot(pixel % image.width - tx, Math.floor(pixel / image.width) - ty) <= fixture.scale / 2), 'the endpoint neighborhood remains within half a bead');
    }
    const target = sampleStructuredImage(image, width, height, patternGeometry(image.width, image.height, width, height, undefined, phase));
    const refs = target.flatMap(cell => {
      const unique = new Map(cell?.modes.flatMap(mode => (mode.components ?? []).filter(component => component.endpointMask !== undefined).map(component => [component.id, component] as const)));
      return [...unique.values()];
    });
    assert.equal(new Set(refs.map(component => component.id)).size, 1);
    const representable = refs.filter(component => component.coverage >= .04);
    assert.equal(representable.reduce((mask, component) => mask | component.endpointMask!, 0), 3, `${fixture.id}: both endpoint sets remain in the supported target graph`);
    assert.ok(Math.abs(refs.reduce((sum, component) => sum + component.coverage, 0) - stroke.area / fixture.scale ** 2) < 1e-10, 'endpoint witnesses do not amplify source area');
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv from 'ajv';
import type { BeadPattern, GenerationRequest, Palette, Srgb8 } from '../src/beadify/contracts/index';
import {
  buildBom, deltaE00, generatePattern, linearToCieLab, linearToOklab, linearToSrgb,
  linearToSrgb8, loadPalette, oklabDistance, oklabToLinear, paletteHash, prepareColors,
  srgb8ToLinear, srgbToLinear, topKColors, toJsonRequest, validatePattern, validateRequest,
  type CieLab,
} from '../src/beadify/core/index';
import { hashJson, sha256 } from '../src/beadify/core/hash';
import { sampleImage } from '../src/beadify/core/sampling';
import { patternGeometry } from '../src/beadify/core/validation';

const close = (actual: number, expected: number, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const palette = (colors: [string, Srgb8][]): Palette => loadPalette({
  id: 'synthetic', version: '1', source: 'Original synthetic numeric fixtures', license: 'CC0-1.0', approximate: true,
  colors: colors.map(([id, srgb8]) => ({ id: `Synthetic/Test/${id}`, brand: 'Synthetic', series: 'Test', code: id, srgb8 })),
});
const BW = palette([['B', [0, 0, 0]], ['W', [255, 255, 255]]]);
const primary = palette([['R', [255, 0, 0]], ['G', [0, 255, 0]], ['B', [0, 0, 255]]]);
const request = (data: number[] | Uint8ClampedArray, imageWidth: number, imageHeight: number, extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
  schemaVersion: 1, revision: 7, image: { width: imageWidth, height: imageHeight, data },
  width: imageWidth, height: imageHeight, palette: BW, method: 'area', maxColors: 12, ...extra,
});

test('sRGB transfer functions and 8-bit RGB round trips', () => {
  close(srgbToLinear(0), 0); close(srgbToLinear(1), 1);
  close(srgbToLinear(0.04045), 0.00313080495356, 1e-14);
  close(srgbToLinear(0.5), 0.21404114048223, 1e-14);
  close(linearToSrgb(0.0031308), 0.040449936, 1e-12);
  for (let byte = 0; byte <= 255; byte++) {
    const rgb: Srgb8 = [byte, 255 - byte, (byte * 71) % 256];
    assert.deepEqual(linearToSrgb8(srgb8ToLinear(rgb)), rgb);
  }
});

test('OKLab black, white and primaries agree with published reference matrices', () => {
  const vectors: [Srgb8, number[]][] = [
    [[0, 0, 0], [0, 0, 0]], [[255, 255, 255], [0.9999999935, 0, 0.0000000373]],
    [[255, 0, 0], [0.6279553606, 0.2248630611, 0.1258462985]],
    [[0, 255, 0], [0.8664396115, -0.2338875742, 0.1794984799]],
    [[0, 0, 255], [0.4520137184, -0.0324569841, -0.3115281477]],
  ];
  for (const [rgb, expected] of vectors) {
    const linear = srgb8ToLinear(rgb), actual = linearToOklab(linear);
    [actual.L, actual.a, actual.b].forEach((value, i) => close(value, expected[i]));
    close(oklabDistance(actual, actual), 0);
    const restored = oklabToLinear(actual);
    close(restored.r, linear.r, 3e-7); close(restored.g, linear.g, 3e-7); close(restored.b, linear.b, 3e-7);
  }
});

test('CIE Lab D65 uses an independent scale and rejects OKLab at runtime', () => {
  const red = linearToCieLab(srgb8ToLinear([255, 0, 0]));
  close(red.L, 53.2407941413); close(red.a, 80.0924595964); close(red.b, 67.2031965159);
  const black = linearToCieLab({ r: 0, g: 0, b: 0 });
  assert.deepEqual(black, { space: 'cie-lab-d65', L: 0, a: 0, b: 0 });
  close(deltaE00(red, red), 0);
  assert.throws(() => deltaE00(linearToOklab({ r: 1, g: 0, b: 0 }) as unknown as CieLab, red), /Expected CIE Lab/);
});

test('CIEDE2000 matches Sharma et al. independent published test vectors including hue-wrap cases', () => {
  // Numeric reference data: https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/dataNprograms/ciede2000testdata.txt
  const vectors = [
    [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
    [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
    [50, 2.8361, -74.0200, 50, 0, -82.7485, 3.4412],
    [50, -1.3802, -84.2814, 50, 0, -82.7485, 1],
    [50, -1.1848, -84.8006, 50, 0, -82.7485, 1],
    [50, -0.9009, -85.5211, 50, 0, -82.7485, 1],
    [50, 0, 0, 50, -1, 2, 2.3669], [50, -1, 2, 50, 0, 0, 2.3669],
    [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
    [50, 2.49, -0.001, 50, -2.49, 0.0010, 7.1792],
    [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
    [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
    [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
    [50, -0.001, 2.49, 50, 0.0010, -2.49, 4.8045],
    [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
    [50, 2.5, 0, 50, 0, -2.5, 4.3065],
    [50, 2.5, 0, 73, 25, -18, 27.1492], [50, 2.5, 0, 61, -5, 29, 22.8977],
    [50, 2.5, 0, 56, -27, -3, 31.9030], [50, 2.5, 0, 58, 24, 15, 19.4535],
    [50, 2.5, 0, 50, 3.1736, 0.5854, 1], [50, 2.5, 0, 50, 3.2972, 0, 1],
    [50, 2.5, 0, 50, 1.8634, 0.5757, 1], [50, 2.5, 0, 50, 3.2592, 0.3350, 1],
    [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
    [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.2630],
    [61.2901, 3.7196, -5.3901, 61.4292, 2.2480, -4.9620, 1.8731],
    [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
    [22.7233, 20.0904, -46.6940, 23.0331, 14.9730, -42.5619, 2.0373],
    [36.4612, 47.8580, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
    [90.8027, -2.0831, 1.4410, 91.1528, -1.6435, 0.0447, 1.4441],
    [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
    [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
    [2.0776, 0.0795, -1.1350, 0.9033, -0.0636, -0.5514, 0.9082],
  ];
  for (const [L1, a1, b1, L2, a2, b2, expected] of vectors) {
    const first: CieLab = { space: 'cie-lab-d65', L: L1, a: a1, b: b1 };
    const second: CieLab = { space: 'cie-lab-d65', L: L2, a: a2, b: b2 };
    close(deltaE00(first, second), expected, 0.00005);
    close(deltaE00(second, first), expected, 0.00005);
  }
});

test('palette loader rejects duplicate IDs/codes, malformed RGB, absent provenance and extra fields', () => {
  const changed = (mutate: (p: any) => void) => { const p = structuredClone(BW); mutate(p); return p; };
  for (const invalid of [
    changed(p => p.colors[1].id = p.colors[0].id),
    changed(p => p.colors[1].code = p.colors[0].code),
    changed(p => p.colors[0].srgb8[0] = 256), changed(p => p.colors[0].srgb8[0] = -1),
    changed(p => p.colors[0].srgb8[0] = 0.5), changed(p => p.colors[0].srgb8[0] = NaN),
    changed(p => p.colors[0].srgb8.pop()), changed(p => delete p.license),
    changed(p => p.source = ' '), changed(p => p.colors[0].material = 'fluorescent'),
    changed(p => p.colors = []), changed(p => p.approximate = 'true'),
  ]) assert.throws(() => loadPalette(invalid), /palette/);
  const cloned = loadPalette(BW);
  cloned.colors[0].srgb8[0] = 42;
  assert.equal(BW.colors[0].srgb8[0], 0);
});

test('Top-K ties are ordered by stable ColorId independently of palette order and locale', () => {
  const same = palette([['z', [0, 0, 0]], ['a', [0, 0, 0]], ['A', [0, 0, 0]]]);
  const target = linearToOklab({ r: 0, g: 0, b: 0 });
  assert.deepEqual(topKColors(target, prepareColors(same.colors), 2).map(c => c.colorId), ['Synthetic/Test/A', 'Synthetic/Test/a']);
  assert.deepEqual(topKColors(target, prepareColors([...same.colors].reverse()), 3), topKColors(target, prepareColors(same.colors), 3));
  assert.throws(() => topKColors(target, prepareColors(same.colors), 0), /k/);
});

test('white is a bead, transparent is null, RGBA is row-major in both baselines', () => {
  for (const method of ['nearest', 'area'] as const) {
    const pattern = generatePattern(request([255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0], 2, 2, { method }));
    assert.deepEqual(pattern.cells, ['Synthetic/Test/W', null, 'Synthetic/Test/B', null]);
    assert.equal(pattern.diagnostics.physicalComponents, 1);
    assert.equal(pattern.diagnostics.monochromeSingletons, 2);
    assert.equal(buildBom(pattern).totalBeads, 2);
  }
});

test('area sampling averages linear light, not gamma-encoded bytes', () => {
  const grayscale = palette([['mid-gamma', [128, 128, 128]], ['mid-linear', [188, 188, 188]]]);
  const image = [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255];
  const pattern = generatePattern(request(image, 2, 2, { width: 1, height: 1, palette: grayscale }));
  assert.deepEqual(pattern.cells, ['Synthetic/Test/mid-linear']);
});

test('area ignores hidden RGB, includes fractional edge area, and distinguishes half-alpha threshold', () => {
  const hiddenBlue = [255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0];
  const pattern = generatePattern(request(hiddenBlue, 2, 2, { width: 1, height: 1, palette: primary }));
  assert.deepEqual(pattern.cells, ['Synthetic/Test/R']);
  const data = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255];
  const geometry = patternGeometry(3, 1, 2, 1);
  const samples = sampleImage({ width: 3, height: 1, data }, 2, 1, geometry, 'area');
  close(oklabDistance(samples[0]!, linearToOklab({ r: 2 / 3, g: 1 / 3, b: 0 })), 0, 1e-14);
  close(oklabDistance(samples[1]!, linearToOklab({ r: 0, g: 1 / 3, b: 2 / 3 })), 0, 1e-14);
  for (const method of ['nearest', 'area'] as const) {
    assert.deepEqual(generatePattern(request([255, 255, 255, 127], 1, 1, { method })).cells, [null]);
    assert.deepEqual(generatePattern(request([255, 255, 255, 128], 1, 1, { method })).cells, ['Synthetic/Test/W']);
  }
});

test('contain transform preserves aspect ratio and leaves transparent margins', () => {
  for (const method of ['nearest', 'area'] as const) {
    const pattern = generatePattern(request([0, 0, 0, 255, 255, 255, 255, 255], 2, 1, { width: 4, height: 4, method }));
    assert.deepEqual(pattern.geometry.sourceToGrid, [2, 0, 0, 0, 2, 1, 0, 0, 1]);
    assert.deepEqual(pattern.cells, [null, null, null, null, 'Synthetic/Test/B', 'Synthetic/Test/B', 'Synthetic/Test/W', 'Synthetic/Test/W', 'Synthetic/Test/B', 'Synthetic/Test/B', 'Synthetic/Test/W', 'Synthetic/Test/W', null, null, null, null]);
  }
});

test('color budgets are hard, deterministic, respect allowed colors and disclose frequency reduction', () => {
  const data = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255];
  const req = request(data, 3, 1, { palette: primary, maxColors: 2 });
  const pattern = generatePattern(req);
  assert.ok(pattern.diagnostics.usedColors <= 2);
  assert.equal(pattern.diagnostics.colorReduction, 'frequency-subpalette');
  assert.match(pattern.diagnostics.warnings.join(' '), /no structure optimizer/);
  assert.ok(pattern.cells.every(cell => cell === 'Synthetic/Test/B' || cell === 'Synthetic/Test/G'));
  const restricted = generatePattern({ ...req, allowedColors: ['Synthetic/Test/R'] });
  assert.deepEqual(restricted.cells, ['Synthetic/Test/R', 'Synthetic/Test/R', 'Synthetic/Test/R']);
  const reordered = { ...req, palette: loadPalette({ ...primary, colors: [...primary.colors].reverse() }) };
  assert.deepEqual(generatePattern(reordered), pattern);
});

test('empty foreground produces a valid empty BOM without NaN', () => {
  const pattern = generatePattern(request([127, 200, 255, 0], 1, 1, { maxColors: 1 }));
  validatePattern(pattern);
  assert.deepEqual(pattern.cells, [null]);
  assert.equal(pattern.diagnostics.usedColors, 0);
  assert.equal(pattern.diagnostics.physicalComponents, 0);
  assert.deepEqual(buildBom(pattern).rows, []);
  assert.equal(buildBom(pattern).totalBeads, 0);
});

test('strict request validation bounds allocation and rejects unsupported constraints', () => {
  const good = request([0, 0, 0, 255], 1, 1);
  const invalids: unknown[] = [
    { ...good, width: 0 }, { ...good, width: 257 }, { ...good, height: 1.5 },
    { ...good, revision: -1 }, { ...good, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, maxColors: 0 }, { ...good, maxColors: 1.5 }, { ...good, maxColors: 513 },
    { ...good, schemaVersion: 2 }, { ...good, method: 'optimizer' },
    { ...good, constraints: [] }, { ...good, requiredColors: ['Synthetic/Test/B'] },
    { ...good, allowedColors: [] }, { ...good, allowedColors: ['unknown'] },
    { ...good, allowedColors: ['Synthetic/Test/B', 'Synthetic/Test/B'] },
    { ...good, image: { width: 4097, height: 1, data: [] } },
    { ...good, image: { width: 4096, height: 4096, data: [] } },
    { ...good, image: { width: 1, height: 1, data: [0, 0, 0] } },
    { ...good, image: { width: 1, height: 1, data: [0, 0, 0, 255.5] } },
    { ...good, image: { width: 1, height: 1, data: [0, 0, 0, Infinity] } },
    { ...good, image: { width: 1, height: 1, data: new Uint8Array(4) } },
  ];
  for (const invalid of invalids) assert.throws(() => validateRequest(invalid), /request/);
});

test('SHA-256 matches Node independent reference across block/padding boundaries', () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1024, 100000]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 37) % 256);
    assert.equal(sha256(bytes), 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
  assert.equal(hashJson('颜色 🌈'), 'sha256:' + createHash('sha256').update(JSON.stringify('颜色 🌈')).digest('hex'));
  for (const value of ['\u007f\u0080\u07ff\u0800\ud800\udfff🌈', 'source-cell,'.repeat(100_000)]) {
    assert.equal(hashJson(value), 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex'));
  }
});

test('same input is reproducible, revision is excluded from config hash and snapshots are independent', () => {
  const original = request(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
  const first = generatePattern(original), second = generatePattern(original);
  assert.deepEqual(first, second);
  assert.deepEqual(generatePattern(toJsonRequest(original)), first);
  const newer = generatePattern({ ...original, revision: 8 });
  assert.equal(newer.configHash, first.configHash);
  assert.equal(newer.inputRevision, 8);
  assert.notEqual(generatePattern({ ...original, maxColors: 1 }).configHash, first.configHash);
  assert.notEqual(generatePattern(request([0, 0, 0, 255], 1, 1)).configHash, first.configHash);
  first.paletteSnapshot.colors[0].srgb8[0] = 123;
  assert.equal(original.palette.colors[0].srgb8[0], 0);
});

test('JSON round trip validates against the source Schema; BOM agrees with nonempty cells', async () => {
  const schema = JSON.parse(await readFile(new URL('../src/beadify/contracts/schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ allErrors: true });
  ajv.addSchema(schema);
  const req = request([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0], 3, 1);
  const pattern = JSON.parse(JSON.stringify(generatePattern(req))) as BeadPattern;
  validatePattern(pattern);
  const bom = buildBom(pattern);
  for (const [name, data] of [['GenerationRequestJson', toJsonRequest(req)], ['Palette', req.palette], ['BeadPattern', pattern], ['Bom', bom]] as const) {
    const validate = ajv.getSchema(`https://beadify.local/contracts/v1#/definitions/${name}`)!;
    assert.equal(validate(data), true, JSON.stringify(validate.errors));
  }
  assert.equal(bom.totalBeads, pattern.cells.filter(cell => cell !== null).length);
  assert.equal(bom.rows.reduce((sum, row) => sum + row.count, 0), bom.totalBeads);
  assert.deepEqual(bom.rows.map(row => row.colorId), ['Synthetic/Test/B', 'Synthetic/Test/W']);
  const different = loadPalette({ ...BW, version: '2' });
  assert.notEqual(paletteHash(different), pattern.paletteHash);
  assert.throws(() => buildBom(pattern, different), /does not match/);
});

test('pattern import rejects corrupt sizes, palette references, counts, geometry and future versions', () => {
  const good = generatePattern(request([0, 0, 0, 255], 1, 1));
  const change = (mutate: (p: any) => void) => { const p = structuredClone(good); mutate(p); return p; };
  for (const invalid of [
    change(p => p.cells.push(null)), change(p => p.cells[0] = 'unknown'),
    change(p => p.schemaVersion = 2), change(p => p.paletteHash = 'sha256:bad'),
    change(p => p.diagnostics.usedColors = 0), change(p => p.geometry.sourceToGrid[0] = NaN),
    change(p => p.geometry.sourceToGrid[0] = 2), change(p => p.configHash = 'bad'),
    change(p => p.script = 'unexpected'),
  ]) assert.throws(() => validatePattern(invalid), /pattern/);
});

test('extended P2/P3 JSON contracts round-trip and reject corrupt diagnostics', async () => {
  const schema = JSON.parse(await readFile(new URL('../src/beadify/contracts/schema.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ allErrors: true }); ajv.addSchema(schema);
  const req = request([0, 0, 0, 255, 255, 255, 255, 255], 2, 1, {
    method: 'optimized', style: 'pixel-art', requiredColors: ['Synthetic/Test/W'],
    preprocessing: { crop: [0, 0, 2, 1], mask: [1, 0], background: 'keep', tolerance: 24 },
    phase: [0.1, 0], constraints: [{ kind: 'protect', cellIndices: [0], strength: 0.8 }], optimization: { iterations: 2, maxEvaluations: 100, symmetry: true },
  });
  const pattern = generatePattern(req);
  for (const [name, data] of [['GenerationRequestJson', toJsonRequest(req)], ['BeadPattern', pattern]] as const) {
    const validate = ajv.getSchema(`https://beadify.local/contracts/v1#/definitions/${name}`)!;
    assert.equal(validate(data), true, JSON.stringify(validate.errors));
  }
  validatePattern(JSON.parse(JSON.stringify(pattern)));
  for (const mutate of [
    (p: BeadPattern) => { p.diagnostics.optimization!.finalEnergy += 1; },
    (p: BeadPattern) => { p.diagnostics.optimization!.terms.edge = NaN; },
    (p: BeadPattern) => { p.diagnostics.optimization!.trace.push(100); },
    (p: BeadPattern) => { p.diagnostics.diagonalContacts = 100; },
  ]) {
    const broken = structuredClone(pattern); mutate(broken);
    assert.throws(() => validatePattern(broken), /pattern.diagnostics/);
  }
});

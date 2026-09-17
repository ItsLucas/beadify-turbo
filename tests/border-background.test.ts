import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWhiteBorder, prepareImage } from '../src/beadify/core/preprocess';
import { generatePattern, loadPalette } from '../src/beadify/core';
import { rebuildTextBackground } from '../src/beadify/core/text-background';
import { emptyTextAnalysis, resealText } from '../src/beadify/text-web';
import { maskRuns } from '../src/beadify/core/text-extraction';
import type { GenerationRequest, RgbaImage, Srgb8 } from '../src/beadify/contracts';

test('white border crop removes outer rows/columns, preserving connected interior background and white highlights', () => {
  const image: RgbaImage = { width: 10, height: 8, data: new Uint8ClampedArray(10 * 8 * 4).fill(255) };
  const points = [[2, 2], [7, 2], [2, 5], [7, 5]];
  for (const [x, y] of points) image.data.set([90, 140, 170, 255], (y * 10 + x) * 4);
  const original = [...image.data], found = detectWhiteBorder(image, { background: 'keep' });
  assert.equal(found.status, 'trimmed'); assert.deepEqual(found.crop, [2, 2, 8, 6]);
  const prepared = prepareImage(image, { crop: found.crop, background: 'keep' });
  assert.equal(prepared.image.width, 6); assert.equal(prepared.image.height, 4);
  assert.equal(prepared.removedPixelCount, 0);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) assert.deepEqual([...prepared.image.data.slice((y * 6 + x) * 4, (y * 6 + x + 1) * 4)], original.slice(((y + 2) * 10 + x + 2) * 4, ((y + 2) * 10 + x + 3) * 4));
  assert.deepEqual([...image.data], original);
  assert.deepEqual(detectWhiteBorder(image, { crop: found.crop }).crop, found.crop);
});

test('white border detection respects pure-white threshold, source keep marks and all-white images', () => {
  const image: RgbaImage = { width: 6, height: 6, data: new Uint8ClampedArray(6 * 6 * 4).fill(255) };
  for (let i = 0; i < 36; i++) image.data.set([253, 253, 253, 255], i * 4);
  image.data.set([40, 60, 80, 255], (2 * 6 + 3) * 4);
  assert.equal(detectWhiteBorder(image).status, 'unchanged');
  assert.deepEqual(detectWhiteBorder(image, {}, 2).crop, [3, 2, 4, 3]);
  const mask = Array(36).fill(0); mask[0] = 1;
  assert.deepEqual(detectWhiteBorder(image, { mask }, 2).crop, [0, 0, 4, 3]);
  image.data.fill(255);
  assert.equal(detectWhiteBorder(image).status, 'empty');
  assert.deepEqual(detectWhiteBorder(image).crop, [0, 0, 6, 6]);
  for (const tolerance of [-1, 33, 1.5, NaN]) assert.throws(() => detectWhiteBorder(image, {}, tolerance), /tolerance/);
});

function textScene(gradient = false, evidence = true) {
  const width = 32, height = 20, data = new Uint8ClampedArray(width * height * 4), oldInk: number[] = [];
  const colorAt = (x: number): Srgb8 => gradient ? [100 + 4 * x, 120 + 3 * x, 140 + 2 * x] : [247, 235, 211];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...colorAt(x), 255], (y * width + x) * 4);
  for (let y = 6; y < 14; y++) for (const x of [12, 13, 18, 19]) { const i = y * width + x; data.set([0, 0, 0, 255], i * 4); oldInk.push(i); }
  const entries: [string, Srgb8][] = [['ink', [0, 0, 0]], ['white', [255, 255, 255]], ...(gradient ? Array.from({ length: width }, (_, x) => [`b${x}`, colorAt(x)] as [string, Srgb8]) : [['cream', colorAt(0)] as [string, Srgb8]])];
  const palette = loadPalette({ id: 'test', version: '1', source: 'original synthetic', license: 'CC0', approximate: false, colors: entries.map(([id, srgb8]) => ({ id: `test:solid:${id}`, code: id, brand: 'test', series: 'solid', srgb8 })) });
  const image = { width, height, data }, request: GenerationRequest = { schemaVersion: 1, revision: 1, width, height, image, palette, method: 'nearest', maxColors: 40 };
  const base = generatePattern(request), empty = emptyTextAnalysis(image);
  const analysis = resealText({ ...empty, regions: [{ id: 'text', parentId: null, polygon: [[6, 3], [26, 3], [26, 17], [6, 17]], granularity: 'line', role: 'text', status: 'verified', transcription: 'HI', detectionScore: null, recognitionScore: null, alignment: 'manual', readingOrder: null, angle: null }],
    evidence: evidence ? [{ id: 'old-ink', regionId: 'text', kind: 'ink', status: 'verified', origin: 'manual', runs: maskRuns(oldInk) }] : [] });
  return { base, analysis, oldInk, width, colorAt };
}

test('retyping repairs old ink on a cream background without introducing a white rectangle', () => {
  const { base, analysis, oldInk } = textScene(), before = JSON.stringify(base);
  const result = rebuildTextBackground(base, analysis, 'text');
  assert.deepEqual(result.repairedCells, [...oldInk].sort((a, b) => a - b));
  assert.equal(result.sourceInkUsed, true);
  for (const i of oldInk) assert.equal(result.cells[i], 'test:solid:cream');
  for (let i = 0; i < base.cells.length; i++) if (!oldInk.includes(i)) assert.equal(result.cells[i], base.cells[i]);
  assert.equal(result.cells.includes('test:solid:white'), false);
  assert.equal(JSON.stringify(base), before);
});

test('background reconstruction continues a gradient while preserving all known texture cells', () => {
  const { base, analysis, oldInk, width, colorAt } = textScene(true);
  const result = rebuildTextBackground(base, analysis, 'text');
  const palette = new Map(base.paletteSnapshot.colors.map(c => [c.id, c.srgb8]));
  for (const i of oldInk) {
    const expected = colorAt(i % width), actual = palette.get(result.cells[i]!)!;
    assert.ok(actual.every((channel, c) => Math.abs(channel - expected[c]) <= 4), `${i}: ${actual} should follow ${expected}`);
  }
  for (let i = 0; i < base.cells.length; i++) if (!oldInk.includes(i)) assert.equal(result.cells[i], base.cells[i]);
});

test('without source ink evidence, background continues from the perimeter and a selected fill fades at its edge', () => {
  const { base, analysis } = textScene(false, false);
  const natural = rebuildTextBackground(base, analysis, 'text');
  assert.equal(natural.sourceInkUsed, false);
  for (const i of natural.repairedCells) assert.equal(natural.cells[i], 'test:solid:cream');
  const chosen = rebuildTextBackground(base, analysis, 'text', 'blend-color', 'test:solid:white');
  assert.equal(chosen.cells[3 * 32 + 6], 'test:solid:cream', 'the outer transition retains its surrounding color');
  assert.equal(chosen.cells[10 * 32 + 16], 'test:solid:white', 'the interior reaches the explicitly chosen color');
  assert.equal(chosen.cells[2 * 32 + 6], base.cells[2 * 32 + 6]);
  const transition = Array.from({ length: 14 }, (_, x) => chosen.cells[5 * 32 + x + 9]);
  assert.ok(transition.includes('test:solid:cream') && transition.includes('test:solid:white'), 'limited palettes soften the edge with mixed bead coverage instead of a hard rectangle');
});

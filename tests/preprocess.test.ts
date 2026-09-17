import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreprocessingOptions, RgbaImage } from '../src/beadify/contracts/index';
import { prepareImage } from '../src/beadify/core/preprocess';

const colors: Record<string, [number, number, number, number]> = {
  '.': [255, 255, 255, 255], '#': [0, 0, 0, 255], Y: [255, 210, 0, 255],
  R: [220, 40, 25, 255], _: [255, 255, 255, 0], h: [30, 80, 110, 128],
};
function fromRows(rows: string[]): RgbaImage {
  assert.ok(rows.every(row => row.length === rows[0].length));
  return { width: rows[0].length, height: rows.length, data: new Uint8ClampedArray(rows.flatMap(row => [...row].flatMap(letter => colors[letter]))) };
}
const alpha = (image: RgbaImage, x: number, y: number) => image.data[(y * image.width + x) * 4 + 3];
const maskFor = (image: RgbaImage) => new Array<number>(image.width * image.height).fill(0);

test('edge removal preserves enclosed white eye highlights across source phases', () => {
  for (let phaseY = 0; phaseY < 3; phaseY++) for (let phaseX = 0; phaseX < 3; phaseX++) {
    const rows = Array.from({ length: 9 }, () => Array<string>(10).fill('.'));
    for (let y = 2 + phaseY; y <= 4 + phaseY; y++) for (let x = 2 + phaseX; x <= 4 + phaseX; x++) rows[y][x] = '#';
    rows[3 + phaseY][3 + phaseX] = '.';
    const image = fromRows(rows.map(row => row.join(''))), source = [...image.data];
    const prepared = prepareImage(image, { background: 'edge' });
    assert.equal(alpha(prepared.image, 0, 0), 0);
    assert.equal(alpha(prepared.image, 3 + phaseX, 3 + phaseY), 255);
    assert.equal(alpha(prepared.image, 2 + phaseX, 2 + phaseY), 255);
    assert.deepEqual([...image.data], source, 'preprocessing must not mutate the source');
  }
});

test('four-neighbor background cannot leak through diagonally touching eye corners', () => {
  const image = fromRows(['.....', '..#..', '.#.#.', '..#..', '.....']);
  const prepared = prepareImage(image, { background: 'edge' });
  assert.equal(alpha(prepared.image, 2, 2), 255);
  assert.equal(alpha(prepared.image, 1, 1), 0);
});

test('keep brush repairs a white subject touching the boundary and acts as a fill barrier', () => {
  const image = fromRows(['.......', '.......', '.......', '...#...', '.......']);
  const mask = maskFor(image);
  for (let y = 0; y < 4; y++) for (let x = 2; x < 5; x++) mask[y * image.width + x] = 1;
  const automatic = prepareImage(image, { background: 'edge' });
  assert.equal(alpha(automatic.image, 3, 1), 0, 'white-on-white requires manual evidence');
  const repaired = prepareImage(image, { background: 'edge', mask });
  assert.equal(alpha(repaired.image, 3, 1), 255);
  assert.equal(alpha(repaired.image, 3, 0), 255);
  assert.equal(alpha(repaired.image, 0, 0), 0);
  assert.equal(alpha(repaired.image, 3, 3), 255);
});

test('small detached tails, multiple subjects and ears at the image edge survive background removal', () => {
  const image = fromRows(['..Y......', '..Y......', '..YY.....', '..YY....Y', '.........', '......R..', '.........']);
  const prepared = prepareImage(image, { background: 'edge' });
  for (const [x, y] of [[2, 0], [2, 1], [3, 3], [8, 3], [6, 5]]) assert.equal(alpha(prepared.image, x, y), 255);
  assert.equal(alpha(prepared.image, 0, 0), 0);
});

test('crop uses exclusive integer bounds and source-space masks while preserving original alpha and RGB', () => {
  const image = fromRows(['YYYY', 'Yh_Y', 'Y.RY', 'YYYY']);
  const mask = maskFor(image);
  mask[1 * image.width + 1] = 1;
  mask[1 * image.width + 2] = 1;
  mask[2 * image.width + 2] = 2;
  const options: PreprocessingOptions = { crop: [1, 1, 3, 3], mask };
  const before = JSON.stringify({ image, options });
  const prepared = prepareImage(image, options);
  assert.equal(prepared.image.width, 2); assert.equal(prepared.image.height, 2);
  assert.deepEqual(prepared.crop, [1, 1, 3, 3]);
  assert.deepEqual(prepared.sourceToPrepared, [1, 0, -1, 0, 1, -1, 0, 0, 1]);
  assert.deepEqual([...prepared.image.data], [30, 80, 110, 128, 255, 255, 255, 0, 255, 255, 255, 255, 220, 40, 25, 0]);
  assert.equal(prepared.removedPixelCount, 1);
  assert.equal(JSON.stringify({ image, options }), before);
  prepared.crop[0] = 0;
  assert.deepEqual(options.crop, [1, 1, 3, 3]);
});

test('crop, removal and manual keep compose without resurrecting alpha or deleting protected highlights', () => {
  const image = fromRows(['RRRRRRR', 'R.....R', 'R.###.R', 'R.#.#.R', 'R.###.R', 'R.._..R', 'RRRRRRR']);
  const mask = maskFor(image);
  mask[1 * image.width + 1] = 1;
  mask[5 * image.width + 3] = 1;
  mask[3 * image.width + 2] = 2;
  const prepared = prepareImage(image, { crop: [1, 1, 6, 6], background: 'edge', mask });
  assert.equal(alpha(prepared.image, 0, 0), 255);
  assert.equal(alpha(prepared.image, 4, 0), 0);
  assert.equal(alpha(prepared.image, 2, 2), 255);
  assert.equal(alpha(prepared.image, 1, 2), 0);
  assert.equal(alpha(prepared.image, 2, 4), 0);
});

test('automatic mode respects existing transparent edges around white subjects', () => {
  const image = fromRows(['__._', '_...', '_...', '____']);
  const prepared = prepareImage(image, { background: 'edge' });
  assert.equal(prepared.backgroundColor, null);
  assert.equal(alpha(prepared.image, 2, 0), 255);
  assert.equal(alpha(prepared.image, 2, 2), 255);
  assert.deepEqual([...prepared.image.data], [...image.data]);
});

test('tolerance is the inclusive maximum sRGB channel difference, without drifting through gradients', () => {
  const image: RgbaImage = { width: 5, height: 3, data: new Uint8ClampedArray(5 * 3 * 4) };
  for (let pixel = 0; pixel < 15; pixel++) image.data.set([240, 240, 240, 255], pixel * 4);
  image.data.set([241, 220, 239, 255], (1 * 5 + 1) * 4);
  image.data.set([230, 201, 239, 255], (1 * 5 + 2) * 4);
  assert.equal(alpha(prepareImage(image, { background: 'edge', tolerance: 19 }).image, 1, 1), 255);
  const prepared = prepareImage(image, { background: 'edge', tolerance: 20 });
  assert.equal(alpha(prepared.image, 1, 1), 0);
  assert.equal(alpha(prepared.image, 2, 1), 255);
});

test('keep/reset defaults preserve pixels and return independent identity-coordinate copies', () => {
  const image = fromRows(['._h', '#YR']);
  const prepared = prepareImage(image);
  assert.deepEqual(prepared.sourceToPrepared, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual([...prepared.image.data], [...image.data]);
  assert.notEqual(prepared.image.data, image.data);
  assert.equal(prepared.removedPixelCount, 0);
});

test('all-empty masks, all-background images and one-pixel dimensions stay finite and deterministic', () => {
  for (const rows of [['.'], ['....'], ['.', '.', '.'], ['__', '__']]) {
    const image = fromRows(rows), options = { background: 'edge' as const };
    const prepared = prepareImage(image, options);
    assert.equal([...prepared.image.data].filter((_, index) => index % 4 === 3).reduce((sum, value) => sum + value, 0), 0);
    assert.deepEqual(prepareImage(image, options), prepared);
  }
  const image = fromRows(['YR', '#h']);
  const prepared = prepareImage(image, { mask: [2, 2, 2, 2] });
  assert.equal(prepared.removedPixelCount, 4);
});

test('preprocessing rejects invalid dimensions, bytes, crop coordinates, mask sizes and enum values before allocation', () => {
  const good = fromRows(['..', '..']);
  for (const image of [
    { ...good, width: 0 }, { ...good, height: 1.5 }, { ...good, width: 4097 },
    { width: 4096, height: 4096, data: [] }, { ...good, data: [0, 0, 0, 255] },
    { ...good, data: new Array(16).fill(256) }, { ...good, data: new Array(16) },
    { ...good, data: new Uint8Array(16) }, null,
  ]) assert.throws(() => prepareImage(image as RgbaImage), /image/);
  for (const options of [
    { crop: [0, 0, 0, 1] }, { crop: [0, 0, 3, 2] }, { crop: [-1, 0, 2, 2] },
    { crop: [0, 0, 1.5, 2] }, { crop: [1, 1, 0, 0] }, { crop: [0, 0, 2] }, { crop: new Array(4) },
    { mask: [0] }, { mask: [0, 0, 0, 3] }, { mask: new Array(4) }, { mask: new Uint8Array(4) },
    { tolerance: -1 }, { tolerance: 256 }, { tolerance: NaN }, { tolerance: 2.5 },
    { background: 'all-white' }, { crop: null }, { mask: null }, { smoothing: 'yes' }, { hallucinate: true }, null, [],
  ]) assert.throws(() => prepareImage(good, options as PreprocessingOptions), /preprocessing/);
});

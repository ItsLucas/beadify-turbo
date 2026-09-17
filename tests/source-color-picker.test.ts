import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicPalette, completePalette } from '../src/palette';
import { sampleSourceColor, similarSourceColors, sourceColorHex } from '../src/source-color-picker';

test('source sampling preserves pixel coordinates and opaque RGB, ignores transparent RGB and composites partial alpha on white', () => {
  const image = { width: 2, height: 2, data: new Uint8ClampedArray([
    20, 40, 60, 255, 255, 0, 0, 0,
    0, 0, 0, 128, 2, 100, 200, 255,
  ]) };
  assert.deepEqual(sampleSourceColor(image, .9, .8), { x: 0, y: 0, rgb: [20, 40, 60], alpha: 255 });
  assert.equal(sampleSourceColor(image, 1, 0), null);
  assert.deepEqual(sampleSourceColor(image, 0, 1)?.rgb, [127, 127, 127]);
  assert.deepEqual(sampleSourceColor(image, 1.9, 1.9)?.rgb, [2, 100, 200]);
  for (const [x, y] of [[-1, 0], [0, -1], [2, 0], [0, 2], [NaN, 0], [0, Infinity]]) assert.equal(sampleSourceColor(image, x, y), null);
  assert.equal(sourceColorHex([2, 100, 200]), '#0264C8');
});

test('recommendations include exact matches first and only use the supplied palette and its saved RGB values', () => {
  const fullOnly = completePalette.find(color => !basicPalette.some(basic => basic.id === color.id))!;
  const before = structuredClone(completePalette);
  assert.equal(similarSourceColors(fullOnly.rgb, completePalette)[0].id, fullOnly.id);
  const basicMatches = similarSourceColors(fullOnly.rgb, basicPalette);
  assert.equal(basicMatches.length, 6);
  assert.equal(new Set(basicMatches.map(color => color.id)).size, 6);
  assert.ok(basicMatches.every(color => basicPalette.some(basic => basic.id === color.id)));
  const savedColor = { ...basicPalette[0], rgb: [1, 2, 3] as [number, number, number], hex: '#010203' };
  assert.deepEqual(similarSourceColors([1, 2, 3], [basicPalette[1], savedColor])[0], savedColor);
  assert.deepEqual(similarSourceColors([1, 2, 3], []), []);
  assert.deepEqual(completePalette, before);
});

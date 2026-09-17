import test from 'node:test';
import assert from 'node:assert/strict';
import { characterErrors, matchTextRegions, sourceRegionIoU } from '../scripts/text-tools';

const box = (l: number, t: number, r: number, b: number) => [[l, t], [r, t], [r, b], [l, b]];
test('OCR matching is one-to-one with explicit unmatched regions and character deletions', () => {
  assert.equal(sourceRegionIoU(box(0, 0, 10, 10), box(5, 0, 15, 10)), 1 / 3);
  const truth = [{ id: 'first', polygon: box(0, 0, 10, 10) }, { id: 'last', polygon: box(20, 0, 30, 10) }];
  const detected = [{ id: 'ocr-first', polygon: box(0, 0, 10, 10) }, { id: 'ocr-last', polygon: box(20, 0, 30, 10) }];
  assert.deepEqual(matchTextRegions(truth, detected).map(m => m.detectedId), ['ocr-first', 'ocr-last']);
  assert.deepEqual(matchTextRegions(truth, detected.slice(0, 1)).map(m => m.detectedId), ['ocr-first', null]);
  assert.deepEqual(matchTextRegions(truth, []), [{ truthId: 'first', detectedId: null, iou: 0 }, { truthId: 'last', detectedId: null, iou: 0 }]);
  assert.equal(characterErrors('苍天呀!', '苍天呀').errors, 1);
  assert.deepEqual(characterErrors('小', ''), { errors: 1, referenceCharacters: 1, cer: 1 });
  assert.equal(characterErrors('é', 'e\u0301').errors, 0);
});

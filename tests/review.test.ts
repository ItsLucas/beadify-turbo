import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePattern } from '../src/beadify/core/index';
import { createSyntheticFixtures } from '../benchmark/synthetic';
import { createReviewPack, summarizeReviews, validateReviewResult, type ReviewInput, type ReviewResult } from '../benchmark/review';

function input(id = 'case-1', groupId = 'source-1'): ReviewInput {
  const fixture = createSyntheticFixtures()[1];
  return { id, groupId, prompt: fixture.inspect, request: fixture.request, variants: [
    { label: 'algorithm-a', pattern: generatePattern({ ...fixture.request, method: 'area' }), provenance: { version: 'a1' } },
    { label: 'algorithm-b', pattern: generatePattern({ ...fixture.request, method: 'nearest' }), provenance: { version: 'b1' } },
  ] };
}

test('review pack blinds algorithm identity, freezes version and pixels, and randomizes reproducibly', () => {
  const inputs = Array.from({ length: 20 }, (_, index) => input(`case-${index}`, `source-${index}`));
  const first = createReviewPack(inputs, 'Development comparison', 'seed-1');
  assert.deepEqual(createReviewPack([...inputs].reverse(), 'Development comparison', 'seed-1'), first);
  assert.ok(!JSON.stringify(first.pack).includes('algorithm-a'));
  assert.ok(!JSON.stringify(first.pack).includes('algorithm-b'));
  assert.ok(!JSON.stringify(first.pack).includes('seed-1'));
  assert.equal(first.key.seed, 'seed-1');
  assert.ok(first.key.cases.some(entry => entry.left.label === 'algorithm-a'));
  assert.ok(first.key.cases.some(entry => entry.left.label === 'algorithm-b'));
  assert.notEqual(createReviewPack(inputs, 'Development comparison', 'seed-2').pack.id, first.pack.id);
  inputs[0].variants[0].provenance = { version: 'a2' };
  assert.notEqual(createReviewPack(inputs, 'Development comparison', 'seed-1').pack.id, first.pack.id);
  assert.equal(summarizeReviews(first.pack, first.key, []).status, 'AWAITING_HUMAN_REVIEW');
  assert.equal(summarizeReviews(first.pack, first.key, []).completedRatings, 0);
});

test('review pack rejects unfair dimensions, palette, budget, duplicated cases and unprepared source', () => {
  for (const mutate of [
    (entry: ReviewInput) => { entry.variants[0].pattern.width++; },
    (entry: ReviewInput) => { entry.variants[0].pattern.cells.pop(); },
    (entry: ReviewInput) => { entry.variants[0].pattern.paletteSnapshot.colors[0].srgb8[0]++; },
    (entry: ReviewInput) => { entry.variants[0].pattern.cells[0] = 'unknown'; },
    (entry: ReviewInput) => { entry.request.maxColors = 1; },
    (entry: ReviewInput) => { entry.request.preprocessing = { smoothing: true }; },
  ]) {
    const entry = input(); mutate(entry);
    assert.throws(() => createReviewPack([entry], 'Test', 'seed'));
  }
  assert.throws(() => createReviewPack([input(), input()], 'Test', 'seed'), /Duplicate case/);
});

test('review scoring decodes swapped sides and weights source groups equally across grid variants', () => {
  const { pack, key } = createReviewPack([
    ...Array.from({ length: 9 }, (_, index) => input(`first-${index}`, 'one-photo')),
    input('second', 'another-photo'),
  ], 'Test', 'seed');
  const result: ReviewResult = { schemaVersion: 1, packId: pack.id, evaluatorId: 'reviewer-1', ratings: key.cases.map(entry => {
    const desired = entry.groupId === 'one-photo' ? 'algorithm-a' : 'algorithm-b';
    return { caseId: entry.id, likeness: entry.left.label === desired ? 'left' : 'right', buildability: 'neither', elapsedMs: 1000, note: 'small feature missing' };
  }) };
  const summary = summarizeReviews(pack, key, [result]);
  assert.equal(summary.originalGroups, 2);
  assert.equal(summary.ratedGroups, 2);
  assert.equal(summary.completedRatings, 10);
  assert.deepEqual(summary.totals.likeness, { first: 9, second: 1, tie: 0, neither: 0 });
  assert.equal(summary.meanGroupNetPreference.likeness, 0, 'nine grid variants must not outweigh an independent source');
  assert.equal(summary.totals.buildability.neither, 10);
  assert.equal(summary.failures.length, 10);
  assert.equal(summary.status, 'DESCRIPTIVE_ONLY');
  assert.throws(() => summarizeReviews(pack, key, [result, result]), /Duplicate evaluator/);
});

test('review results reject stale versions, duplicate rows and invalid ratings; key binds labels and provenance', () => {
  const { pack, key } = createReviewPack([input()], 'Test', 'seed');
  const result: ReviewResult = { schemaVersion: 1, packId: pack.id, evaluatorId: 'reviewer', ratings: [
    { caseId: pack.cases[0].id, likeness: 'tie', buildability: 'neither', elapsedMs: 0, note: '' },
  ] };
  validateReviewResult(result, pack);
  const longReview = structuredClone(result); longReview.ratings[0].elapsedMs = 86_401_000;
  validateReviewResult(longReview, pack);
  for (const mutate of [
    (value: any) => { value.packId = 'older-pack'; },
    (value: any) => { value.evaluatorId = ''; },
    (value: any) => { value.ratings.push(value.ratings[0]); },
    (value: any) => { value.ratings[0].caseId = 'unknown'; },
    (value: any) => { value.ratings[0].likeness = 'maybe'; },
    (value: any) => { value.ratings[0].elapsedMs = -1; },
    (value: any) => { value.ratings[0].elapsedMs = NaN; },
  ]) {
    const invalid = structuredClone(result); mutate(invalid);
    assert.throws(() => validateReviewResult(invalid, pack));
  }
  const changed = structuredClone(pack); changed.cases[0].left.image += 'x';
  assert.throws(() => summarizeReviews(changed, key, [result]), /content changed/);
  const changedKey = structuredClone(key);
  [changedKey.cases[0].left.label, changedKey.cases[0].right.label] = [changedKey.cases[0].right.label, changedKey.cases[0].left.label];
  assert.throws(() => summarizeReviews(pack, changedKey, [result]), /provenance or labels changed/);
});

import assert from 'node:assert/strict';
import type { BeadPattern, GenerationRequest } from '../src/beadify/contracts/index';
import { paletteHash, validateRequest } from '../src/beadify/core/index';
import { hashJson } from '../src/beadify/core/hash';
import { rgbaToPng, sha256 } from './synthetic';

export type ReviewChoice = 'left' | 'right' | 'tie' | 'neither';
export interface ReviewRating {
  caseId: string;
  likeness: ReviewChoice;
  buildability: ReviewChoice;
  elapsedMs: number;
  note: string;
}
export interface ReviewResult {
  schemaVersion: 1;
  packId: string;
  evaluatorId: string;
  ratings: ReviewRating[];
}
export interface ReviewCase {
  id: string;
  groupId: string;
  configHash: string;
  prompt: string;
  sourceImage: string;
  width: number;
  height: number;
  maxColors: number;
  left: { image: string; hash: string };
  right: { image: string; hash: string };
}
export interface ReviewPack {
  schemaVersion: 1;
  id: string;
  title: string;
  cases: ReviewCase[];
}
type DisplayPattern = Pick<BeadPattern, 'width' | 'height' | 'cells' | 'paletteSnapshot'>;
export interface ReviewInput {
  id: string;
  /** Original image/object identity; multiple crops or grid sizes share this value. */
  groupId: string;
  prompt: string;
  /** Already prepared common subject; no algorithm may change the crop or mask. */
  request: GenerationRequest;
  variants: [
    { label: string; pattern: DisplayPattern; provenance: unknown },
    { label: string; pattern: DisplayPattern; provenance: unknown },
  ];
}
export interface ReviewKey {
  schemaVersion: 1;
  packId: string;
  seed: string;
  cases: Array<{
    id: string; groupId: string; configHash: string; sourceRgbaHash: string; paletteHash: string;
    left: { label: string; hash: string; provenance: unknown };
    right: { label: string; hash: string; provenance: unknown };
  }>;
}

const pngUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function nonempty(value: unknown, name: string, limit = 256): asserts value is string {
  assert.ok(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, `${name}: invalid text`);
}
function renderPattern(pattern: DisplayPattern, request: GenerationRequest): string {
  assert.equal(pattern.width, request.width, 'Pattern width differs from common task');
  assert.equal(pattern.height, request.height, 'Pattern height differs from common task');
  assert.equal(pattern.cells.length, request.width * request.height, 'Truncated pattern');
  assert.equal(paletteHash(pattern.paletteSnapshot), paletteHash(request.palette), 'Pattern palette differs from common task');
  assert.ok(new Set(pattern.cells.filter(cell => cell !== null)).size <= request.maxColors, 'Pattern exceeds common color budget');
  const colors = new Map(request.palette.colors.map(color => [color.id, color.srgb8]));
  const rgba = new Uint8ClampedArray(pattern.cells.length * 4);
  pattern.cells.forEach((id, index) => {
    if (id === null) return;
    const rgb = colors.get(id);
    assert.ok(rgb, `Unknown pattern color: ${id}`);
    rgba.set([...rgb, 255], index * 4);
  });
  return pngUrl(rgbaToPng(pattern.width, pattern.height, rgba));
}

/** Deterministic seed randomizes case order and sides; the separate key stays with the organizer. */
export function createReviewPack(inputs: ReviewInput[], title: string, seed: string): { pack: ReviewPack; key: ReviewKey } {
  nonempty(title, 'title'); nonempty(seed, 'seed');
  assert.ok(inputs.length > 0 && inputs.length <= 1000, 'Expected 1..1000 review cases');
  const ids = new Set<string>(), labels = inputs[0].variants.map(variant => variant.label).sort(compare);
  labels.forEach(label => nonempty(label, 'variant label'));
  assert.notEqual(labels[0], labels[1], 'Variants need distinct labels');
  const entries = inputs.map(input => {
    nonempty(input.id, 'case id'); nonempty(input.groupId, 'group id'); nonempty(input.prompt, 'prompt', 4096);
    assert.ok(!ids.has(input.id), `Duplicate case ${input.id}`); ids.add(input.id);
    validateRequest(input.request);
    assert.ok(!input.request.preprocessing, 'Review input must use an already prepared common subject');
    assert.deepEqual(input.variants.map(variant => variant.label).sort(compare), labels, 'All cases must compare the same variants');
    const request = input.request, sourceRgbaHash = sha256(Uint8Array.from(request.image.data));
    const variants = [...input.variants].sort((a, b) => compare(a.label, b.label)).map(variant => {
      const image = renderPattern(variant.pattern, request);
      return { ...variant, image, hash: sha256(image) };
    });
    const configHash = hashJson({ sourceRgbaHash, width: request.width, height: request.height,
      palette: paletteHash(request.palette), maxColors: request.maxColors,
      variants: variants.map(({ label, hash, provenance }) => ({ label, hash, provenance })) });
    if (Number.parseInt(hashJson([seed, input.id, 'side']).slice(-2), 16) % 2) variants.reverse();
    const [left, right] = variants;
    const visible: ReviewCase = { id: input.id, groupId: input.groupId, configHash, prompt: input.prompt,
      sourceImage: pngUrl(rgbaToPng(request.image.width, request.image.height, request.image.data)),
      width: request.width, height: request.height, maxColors: request.maxColors,
      left: { image: left.image, hash: left.hash }, right: { image: right.image, hash: right.hash } };
    const key = { id: input.id, groupId: input.groupId, configHash, sourceRgbaHash, paletteHash: paletteHash(request.palette),
      left: { label: left.label, hash: left.hash, provenance: left.provenance },
      right: { label: right.label, hash: right.hash, provenance: right.provenance } };
    return { visible, key, order: hashJson([seed, input.id, 'order']) };
  }).sort((a, b) => compare(a.order, b.order) || compare(a.visible.id, b.visible.id));
  const content = { schemaVersion: 1 as const, title, cases: entries.map(entry => entry.visible) };
  const pack = { ...content, id: hashJson(content) };
  return { pack, key: { schemaVersion: 1, packId: pack.id, seed, cases: entries.map(entry => entry.key) } };
}

export function validateReviewResult(value: unknown, pack: ReviewPack): asserts value is ReviewResult {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid review result');
  const result = value as ReviewResult;
  assert.equal(result.schemaVersion, 1, 'Unsupported result schema');
  assert.equal(result.packId, pack.id, 'Result belongs to a different review pack/version');
  nonempty(result.evaluatorId, 'evaluator id', 128);
  assert.ok(Array.isArray(result.ratings) && result.ratings.length <= pack.cases.length, 'Invalid ratings');
  const cases = new Set(pack.cases.map(entry => entry.id)), seen = new Set<string>();
  for (const rating of result.ratings) {
    assert.ok(rating && typeof rating === 'object', 'Invalid rating');
    assert.ok(cases.has(rating.caseId) && !seen.has(rating.caseId), 'Unknown or repeated case'); seen.add(rating.caseId);
    for (const metric of ['likeness', 'buildability'] as const) {
      assert.ok(['left', 'right', 'tie', 'neither'].includes(rating[metric]), `Invalid ${metric} choice`);
    }
    assert.ok(Number.isFinite(rating.elapsedMs) && rating.elapsedMs >= 0 && rating.elapsedMs <= Number.MAX_SAFE_INTEGER, 'Invalid elapsed time');
    assert.ok(typeof rating.note === 'string' && rating.note.length <= 4096, 'Invalid failure note');
  }
}

/** Descriptive human results only. Each original group gets equal weight in the aggregate. */
export function summarizeReviews(pack: ReviewPack, key: ReviewKey, values: unknown[]) {
  const { id, ...content } = pack;
  assert.equal(id, hashJson(content), 'Review pack content changed');
  assert.equal(key.schemaVersion, 1); assert.equal(key.packId, id, 'Wrong answer key');
  assert.equal(key.cases.length, pack.cases.length, 'Incomplete answer key');
  const keyById = new Map(key.cases.map(entry => [entry.id, entry]));
  assert.equal(keyById.size, key.cases.length, 'Duplicate answer key case');
  const labels = [key.cases[0].left.label, key.cases[0].right.label].sort(compare);
  assert.notEqual(labels[0], labels[1]);
  for (const entry of pack.cases) {
    const answer = keyById.get(entry.id); assert.ok(answer, 'Missing answer key case');
    assert.equal(answer.groupId, entry.groupId); assert.equal(answer.configHash, entry.configHash);
    assert.deepEqual([answer.left.label, answer.right.label].sort(compare), labels);
    for (const side of ['left', 'right'] as const) {
      assert.equal(answer[side].hash, entry[side].hash, 'Answer key side mismatch');
      assert.equal(entry[side].hash, sha256(entry[side].image), 'Pattern image changed');
    }
    assert.equal(entry.configHash, hashJson({ sourceRgbaHash: answer.sourceRgbaHash, width: entry.width, height: entry.height,
      palette: answer.paletteHash, maxColors: entry.maxColors,
      variants: [answer.left, answer.right].sort((a, b) => compare(a.label, b.label)),
    }), 'Answer key provenance or labels changed');
  }
  const evaluators = new Set<string>();
  const results = values.map(value => {
    validateReviewResult(value, pack);
    assert.ok(!evaluators.has(value.evaluatorId), 'Duplicate evaluator: provide one latest export per evaluator');
    evaluators.add(value.evaluatorId); return value;
  });
  type Counts = { first: number; second: number; tie: number; neither: number };
  const emptyCounts = (): Counts => ({ first: 0, second: 0, tie: 0, neither: 0 });
  const groups = new Map<string, { likeness: Counts; buildability: Counts; ratings: number }>();
  const totals = { likeness: emptyCounts(), buildability: emptyCounts() };
  const failures: Array<{ evaluatorId: string; caseId: string; groupId: string; note: string }> = [];
  for (const result of results) for (const rating of result.ratings) {
    const entry = keyById.get(rating.caseId)!;
    let group = groups.get(entry.groupId);
    if (!group) { group = { likeness: emptyCounts(), buildability: emptyCounts(), ratings: 0 }; groups.set(entry.groupId, group); }
    group.ratings++;
    for (const metric of ['likeness', 'buildability'] as const) {
      const choice = rating[metric];
      const bucket = choice === 'tie' || choice === 'neither' ? choice : entry[choice].label === labels[0] ? 'first' : 'second';
      group[metric][bucket]++; totals[metric][bucket]++;
    }
    if (rating.note.trim()) failures.push({ evaluatorId: result.evaluatorId, caseId: rating.caseId, groupId: entry.groupId, note: rating.note });
  }
  const grouped = [...groups].sort(([a], [b]) => compare(a, b)).map(([groupId, group]) => ({ groupId, ...group }));
  const meanGroupNetPreference = (metric: 'likeness' | 'buildability') => grouped.length
    ? grouped.reduce((sum, group) => sum + (group[metric].first - group[metric].second) / group.ratings, 0) / grouped.length : null;
  return { schemaVersion: 1, packId: pack.id, status: grouped.length ? 'DESCRIPTIVE_ONLY' : 'AWAITING_HUMAN_REVIEW',
    labels: { first: labels[0], second: labels[1] }, evaluatorCount: evaluators.size,
    totalCases: pack.cases.length, originalGroups: new Set(pack.cases.map(entry => entry.groupId)).size,
    ratedGroups: grouped.length, completedRatings: grouped.reduce((sum, group) => sum + group.ratings, 0),
    totals, groups: grouped, meanGroupNetPreference: { likeness: meanGroupNetPreference('likeness'), buildability: meanGroupNetPreference('buildability') }, failures,
    limitations: ['Development comparisons are not an independent holdout.', 'Rows from the same original image are grouped, not counted as independent images.',
      'No significance or general quality superiority claim; elapsed time is review time, not editing time.'] };
}

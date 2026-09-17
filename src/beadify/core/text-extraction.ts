import type { RgbaImage, TextAnalysis, TextEvidence } from '../contracts';
import { createTextAnalysis, validateTextAnalysis } from './text-analysis';
import { sha256 } from './hash';
import { linearToOklab, oklabDistance, srgb8ToLinear } from './color';

export const TEXT_EXTRACTION_VERSION = 'source-text-layers-v1';
export function textPointInside(x: number, y: number, polygon: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function maskRuns(indices: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const i of [...new Set(indices)].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1]; if (last && last[0] + last[1] === i) last[1]++; else runs.push([i, 1]);
  }
  return runs;
}
/** Conservative two-way source segmentation. Colors remain source RGB, including
 * colored faces/outlines/shadows. Complex background is unknown, never inpainted. */
export function extractTextEvidence(input: TextAnalysis, image: RgbaImage) {
  validateTextAnalysis(input);
  if (image.width !== input.source.width || image.height !== input.source.height || image.data.length !== image.width * image.height * 4 || !image.data.every(v => Number.isInteger(v) && v >= 0 && v <= 255) || sha256(image.data) !== input.source.rgbaHash) throw new Error('Text extraction requires matching original RGBA');
  const { contentHash: _hash, cacheKey: _key, ...draft } = JSON.parse(JSON.stringify(input)) as TextAnalysis;
  const evidence: TextEvidence[] = draft.evidence.filter(e => e.origin !== 'source-extractor'), diagnostics: { regionId: string; status: string; backgroundShare?: number; inkPixels?: number }[] = [];
  const claimed = new Uint8Array(image.width * image.height);
  const preserved = new Set(evidence.map(e => e.id));
  let runCount = 0, pixelCount = 0;
  for (const e of evidence) for (const [start, length] of e.runs) {
    runCount++; pixelCount += length;
    if (e.status === 'verified') for (let i = start; i < start + length; i++) claimed[i] = e.kind === 'background' ? 2 : 1;
  }
  for (const region of draft.regions) {
    if (region.parentId !== null || region.role !== 'text' || region.alignment === 'recognition-estimate') continue;
    if (evidence.some(e => e.regionId === region.id && e.origin !== 'source-extractor')) { diagnostics.push({ regionId: region.id, status: 'EXPLICIT_SOURCE_EVIDENCE_RETAINED' }); continue; }
    const admissible = region.status === 'verified' || input.provider.kind === 'ocr' && region.transcription.trim() && (region.detectionScore ?? 0) >= .5 && (region.recognitionScore ?? 0) >= .6;
    if (!admissible) { diagnostics.push({ regionId: region.id, status: 'UNKNOWN_REGION' }); continue; }
    const xs = region.polygon.map(p => p[0]), ys = region.polygon.map(p => p[1]);
    const l = Math.floor(Math.min(...xs)), r = Math.ceil(Math.max(...xs)), t = Math.floor(Math.min(...ys)), b = Math.ceil(Math.max(...ys));
    if ((r - l) * (b - t) > 1_048_576) { diagnostics.push({ regionId: region.id, status: 'REGION_RESOURCE_LIMIT' }); continue; }
    const mask = new Set<number>(), boundary: number[] = [], histogram = new Map<string, number[]>();
    for (let y = t; y < b; y++) for (let x = l; x < r; x++) if (textPointInside(x + .5, y + .5, region.polygon) && image.data[(y * image.width + x) * 4 + 3] >= 128) mask.add(y * image.width + x);
    for (const i of mask) {
      const x = i % image.width;
      if (x > 0 && x + 1 < image.width && [i - 1, i + 1, i - image.width, i + image.width].every(n => mask.has(n))) continue;
      boundary.push(i);
      const key = [0, 1, 2].map(k => Math.floor(image.data[i * 4 + k] / 16)).join(',');
      const bin = histogram.get(key) ?? []; bin.push(i); histogram.set(key, bin);
    }
    const dominant = [...histogram.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))[0]?.[1];
    if (!dominant?.length) { diagnostics.push({ regionId: region.id, status: 'NO_OPAQUE_BOUNDARY' }); continue; }
    const mean = [0, 1, 2].map(k => dominant.reduce((sum, i) => sum + image.data[i * 4 + k], 0) / dominant.length) as [number, number, number];
    const bg = linearToOklab(srgb8ToLinear(mean));
    const color = (i: number) => linearToOklab(srgb8ToLinear([image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]]));
    const backgroundShare = boundary.filter(i => oklabDistance(color(i), bg) <= .075).length / boundary.length;
    if (backgroundShare < .7) { diagnostics.push({ regionId: region.id, status: 'UNKNOWN_COMPLEX_BACKGROUND', backgroundShare }); continue; }
    const ink: number[] = [], background: number[] = []; let strong = 0;
    for (const i of mask) {
      const distance = oklabDistance(color(i), bg);
      if (distance >= .1) ink.push(i); else background.push(i);
      if (distance >= .18) strong++;
    }
    if (!ink.length || ink.length > mask.size * .65 || strong < ink.length * .65) { diagnostics.push({ regionId: region.id, status: 'UNKNOWN_LOW_SEPARATION', backgroundShare }); continue; }
    if (ink.some(i => claimed[i] === 2) || background.some(i => claimed[i] === 1)) { diagnostics.push({ regionId: region.id, status: 'OVERLAPPING_SOURCE_CONFLICT' }); continue; }
    const ir = maskRuns(ink), br = maskRuns(background);
    if (runCount + ir.length + br.length > 16384 || pixelCount + mask.size > 4_194_304 || evidence.length + 2 > 128) { diagnostics.push({ regionId: region.id, status: 'EVIDENCE_RESOURCE_LIMIT' }); continue; }
    region.status = 'verified';
    evidence.push({ id: `${region.id}-ink`, regionId: region.id, kind: 'ink', status: 'verified', origin: 'source-extractor', runs: ir },
      { id: `${region.id}-background`, regionId: region.id, kind: 'background', status: 'verified', origin: 'source-extractor', runs: br });
    ink.forEach(i => claimed[i] = 1); background.forEach(i => claimed[i] = 2);
    runCount += ir.length + br.length; pixelCount += mask.size;
    diagnostics.push({ regionId: region.id, status: 'SOURCE_LAYERS_EXTRACTED', backgroundShare, inkPixels: ink.length });
  }
  return { analysis: createTextAnalysis({ ...draft, evidence, relations: draft.relations.filter(r => r.evidenceIds.every(id => preserved.has(id))) }), diagnostics, version: TEXT_EXTRACTION_VERSION };
}

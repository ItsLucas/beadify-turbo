import type { RgbaImage, TextAnalysis, TextProvider, TextSource } from '../contracts';
import { canonicalJson, hashJson, sha256 } from './hash';
import { patternGeometry, ValidationError } from './validation';

export const TEXT_LIMITS = Object.freeze({ regions: 128, polygonPoints: 16, transcription: 512,
  runs: 16384, evidencePixels: 4_194_304, cacheBytes: 2 * 1024 * 1024, rawOutput: 32768 });
type Point = [number, number];
const fail = (path: string, message: string): never => { throw new ValidationError(`textAnalysis.${path}`, message); };
function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail(path, 'expected plain object');
  const record = value as Record<string, unknown>;
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(record, key)) fail(`${path}.${key}`, 'missing field');
  for (const key of Object.keys(record)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unsupported field');
  return record;
}
function list(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `expected ${min}..${max} entries`);
  return value as unknown[];
}
function number(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) fail(path, 'invalid number');
  return value as number;
}
function string(value: unknown, path: string, max = 256, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail(path, 'invalid string');
  return value as string;
}
function choice(value: unknown, path: string, values: unknown[]) { if (!values.includes(value)) fail(path, 'unsupported value'); }
function digest(value: unknown, path: string) { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail(path, 'expected SHA-256'); }
const nullable = (value: unknown, fn: (value: unknown) => unknown) => { if (value !== null) fn(value); };
export function validateAnalysisProvider(value: unknown, path = 'provider'): void {
  const p = object(value, path, ['kind', 'id', 'version', 'modelHash', 'configHash', 'promptHash', 'device']);
  choice(p.kind, `${path}.kind`, ['none', 'fixture', 'manual', 'ocr', 'vlm']);
  for (const key of ['id', 'version', 'device']) string(p[key], `${path}.${key}`, key === 'version' ? 256 : 128);
  digest(p.configHash, `${path}.configHash`);
  for (const key of ['modelHash', 'promptHash']) nullable(p[key], v => digest(v, `${path}.${key}`));
  if (['ocr', 'vlm'].includes(p.kind as string) && p.modelHash === null) fail(path, 'model providers require pinned weight hash');
}
const provider = validateAnalysisProvider;

/** Homogeneous coordinates preserve skew/perspective for OCR round trips. */
export function transformTextPoint(matrix: readonly number[], point: readonly number[]): Point {
  if (matrix.length !== 9 || !matrix.every(Number.isFinite) || point.length !== 2 || !point.every(Number.isFinite)) fail('transform', 'invalid matrix or point');
  const [x, y] = point, w = matrix[6] * x + matrix[7] * y + matrix[8];
  if (Math.abs(w) < 1e-9) fail('transform', 'point at projective horizon');
  const result: Point = [(matrix[0] * x + matrix[1] * y + matrix[2]) / w, (matrix[3] * x + matrix[4] * y + matrix[5]) / w];
  if (!result.every(Number.isFinite)) fail('transform', 'nonfinite result');
  return result;
}
function validateSource(value: unknown): asserts value is TextSource {
  const s = object(value, 'source', ['rgbaHash', 'width', 'height', 'analysisWidth', 'analysisHeight', 'sourceToAnalysis', 'analysisToSource', 'preprocessingHash']);
  digest(s.rgbaHash, 'source.rgbaHash'); digest(s.preprocessingHash, 'source.preprocessingHash');
  for (const k of ['width', 'height', 'analysisWidth', 'analysisHeight']) number(s[k], `source.${k}`, 1, 4096, true);
  if ((s.width as number) * (s.height as number) > 4_194_304 || (s.analysisWidth as number) * (s.analysisHeight as number) > 4_194_304) fail('source', 'pixel limit');
  for (const k of ['sourceToAnalysis', 'analysisToSource']) list(s[k], `source.${k}`, 9, 9).forEach(v => number(v, `source.${k}`, -1e6, 1e6));
  const a = s.sourceToAnalysis as number[], b = s.analysisToSource as number[];
  const product = Array.from({ length: 9 }, (_, i) => [0, 1, 2].reduce((sum, k) => sum + a[Math.floor(i / 3) * 3 + k] * b[k * 3 + i % 3], 0));
  const scale = product[8];
  if (Math.abs(scale) < 1e-9 || product.some((v, i) => Math.abs(v / scale - (i % 4 === 0 ? 1 : 0)) > 1e-7)) fail('source', 'transforms are not inverses');
  for (const [matrix, width, height] of [[a, s.width, s.height], [b, s.analysisWidth, s.analysisHeight]] as [number[], number, number][]) {
    const w = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => matrix[6] * x + matrix[7] * y + matrix[8]);
    if (w.some(v => Math.abs(v) < 1e-9 || Math.sign(v) !== Math.sign(w[0]))) fail('source', 'projective horizon crosses image');
  }
}
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) < 1e-8 && p[0] >= Math.min(a[0], b[0]) - 1e-8 && p[0] <= Math.max(a[0], b[0]) + 1e-8 && p[1] >= Math.min(a[1], b[1]) - 1e-8 && p[1] <= Math.max(a[1], b[1]) + 1e-8;
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0 || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function polygon(value: unknown, path: string, source: TextSource): Point[] {
  const points = list(value, path, 3, TEXT_LIMITS.polygonPoints).map((p, i) => {
    const pair = list(p, `${path}[${i}]`, 2, 2);
    return [number(pair[0], path, 0, source.width), number(pair[1], path, 0, source.height)] as Point;
  });
  if (new Set(points.map(p => p.join(','))).size !== points.length) fail(path, 'duplicate polygon vertex');
  const area = points.reduce((v, a, i) => { const b = points[(i + 1) % points.length]; return v + a[0] * b[1] - b[0] * a[1]; }, 0);
  if (Math.abs(area) < 1e-8) fail(path, 'zero-area polygon');
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (j === i + 1 || i === 0 && j === points.length - 1) continue;
    if (intersects(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) fail(path, 'self-intersecting polygon');
  }
  return points;
}
function inside(p: Point, points: number[][]): boolean {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j] as Point, b = points[i] as Point;
    if (onSegment(a, b, p)) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
function byteLength(value: string): number {
  let count = 0;
  for (const c of value) { const cp = c.codePointAt(0)!; count += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; }
  return count;
}

/** Analysis identity excludes grid size and palette; result integrity covers every field. */
export function textAnalysisCacheKey(source: TextSource, inputProvider: TextProvider, suggestionProviders: readonly TextProvider[] = []): string {
  validateSource(source); provider(inputProvider, 'provider');
  list(suggestionProviders, 'suggestionProviders', 0, 128).forEach(v => provider(v, 'suggestionProvider'));
  return hashJson({ version: 'beadify-text-analysis-v1', source, provider: inputProvider,
    suggestionProviders: [...new Set(suggestionProviders.map(p => canonicalJson(p)))].sort() });
}
type TextDraft = Omit<TextAnalysis, 'cacheKey' | 'contentHash'>;
export function createTextAnalysis(draft: TextDraft): TextAnalysis {
  const content = { ...draft, cacheKey: textAnalysisCacheKey(draft.source, draft.provider, draft.suggestions.map(s => s.provider)) };
  const result = { ...content, contentHash: hashJson(content) };
  validateTextAnalysis(result);
  return JSON.parse(JSON.stringify(result)) as TextAnalysis;
}

/** Bounds and references are checked before hashing or materializing masks. */
export function validateTextAnalysis(input: unknown): asserts input is TextAnalysis {
  const a = object(input, '', ['schemaVersion', 'kind', 'source', 'provider', 'regions', 'suggestions', 'corrections', 'evidence', 'relations', 'rawOutput', 'cacheKey', 'contentHash']);
  choice(a.schemaVersion, 'schemaVersion', [1]); choice(a.kind, 'kind', ['text-analysis']);
  validateSource(a.source); provider(a.provider, 'provider'); const source = a.source;
  digest(a.cacheKey, 'cacheKey'); digest(a.contentHash, 'contentHash'); string(a.rawOutput, 'rawOutput', TEXT_LIMITS.rawOutput, true);
  const regions = list(a.regions, 'regions', 0, 128), ids = new Set<string>();
  for (const [i, value] of regions.entries()) {
    const p = `regions[${i}]`, r = object(value, p, ['id', 'parentId', 'polygon', 'granularity', 'role', 'status', 'transcription', 'detectionScore', 'recognitionScore', 'alignment', 'readingOrder', 'angle']);
    const id = string(r.id, `${p}.id`, 128); if (ids.has(id)) fail(p, 'duplicate region id'); ids.add(id);
    nullable(r.parentId, v => string(v, p, 128)); polygon(r.polygon, `${p}.polygon`, source);
    choice(r.granularity, p, ['line', 'word', 'character', 'unknown']); choice(r.role, p, ['text', 'logo', 'watermark', 'artwork', 'unknown']);
    choice(r.status, p, ['verified', 'unverified', 'unknown']); choice(r.alignment, p, ['none', 'detection', 'recognition-estimate', 'manual']);
    string(r.transcription, `${p}.transcription`, 512, true);
    for (const k of ['detectionScore', 'recognitionScore']) nullable(r[k], v => number(v, `${p}.${k}`, 0, 1));
    nullable(r.readingOrder, v => number(v, p, 0, 127, true)); nullable(r.angle, v => number(v, p, -180, 180));
  }
  const record = input as TextAnalysis, byId = new Map(record.regions.map(r => [r.id, r]));
  for (const r of record.regions) {
    const seen = new Set([r.id]); let parent = r.parentId;
    while (parent !== null) { if (!ids.has(parent) || seen.has(parent)) fail('regions', 'missing or cyclic parent'); seen.add(parent); parent = byId.get(parent)!.parentId; }
  }
  for (const s of list(a.suggestions, 'suggestions', 0, 128)) {
    const v = object(s, 'suggestion', ['provider', 'regionId', 'polygon', 'role', 'transcription', 'reason']); provider(v.provider, 'suggestion.provider');
    if (v.regionId !== null && !ids.has(v.regionId as string)) fail('suggestion', 'missing region');
    if (v.regionId === null && v.polygon === null) fail('suggestion', 'requires region or proposed polygon');
    nullable(v.polygon, p => polygon(p, 'suggestion.polygon', source));
    choice(v.role, 'suggestion.role', ['text', 'logo', 'watermark', 'artwork', 'unknown']);
    nullable(v.transcription, t => string(t, 'suggestion.transcription', 512, true)); string(v.reason, 'suggestion.reason', 512);
  }
  const corrected = new Set<string>();
  for (const c of list(a.corrections, 'corrections', 0, 128)) {
    const v = object(c, 'correction', ['regionId', 'transcription', 'origin']);
    if (!ids.has(v.regionId as string) || corrected.has(v.regionId as string)) fail('correction', 'missing or repeated region');
    corrected.add(v.regionId as string); string(v.transcription, 'correction.transcription', 512, true); choice(v.origin, 'correction.origin', ['manual']);
  }
  let runs = 0, pixels = 0;
  const evidenceIds = new Set<string>();
  for (const value of list(a.evidence, 'evidence', 0, 128)) {
    const v = object(value, 'evidence', ['id', 'regionId', 'kind', 'status', 'origin', 'runs']);
    const id = string(v.id, 'evidence.id', 128); if (evidenceIds.has(id)) fail('evidence', 'duplicate id'); evidenceIds.add(id);
    if (!ids.has(v.regionId as string)) fail('evidence', 'missing region');
    choice(v.kind, 'evidence.kind', ['ink', 'outline', 'shadow', 'background']); choice(v.status, 'evidence.status', ['verified', 'unknown']);
    choice(v.origin, 'evidence.origin', ['fixture', 'manual', 'source-extractor']);
    let end = -1;
    for (const pair of list(v.runs, 'evidence.runs', 0, TEXT_LIMITS.runs)) {
      const run = list(pair, 'evidence.run', 2, 2), start = number(run[0], 'evidence.start', 0, source.width * source.height - 1, true), length = number(run[1], 'evidence.length', 1, source.width * source.height, true);
      if (start < end || start + length > source.width * source.height) fail('evidence.runs', 'overlap, order or bounds');
      end = start + length; pixels += length; runs++;
      if (runs > TEXT_LIMITS.runs || pixels > TEXT_LIMITS.evidencePixels) fail('evidence', 'aggregate evidence limit');
    }
    const r = byId.get(v.regionId as string)!;
    if (v.status === 'verified' && (r.status !== 'verified' || !['text', 'logo', 'watermark'].includes(r.role))) fail('evidence', 'verified evidence requires verified text region');
  }
  const relationKinds = new Map<string, string>();
  for (const value of list(a.relations, 'relations', 0, 128)) {
    const v = object(value, 'relation', ['kind', 'evidenceIds', 'status']);
    choice(v.kind, 'relation.kind', ['connected', 'separate', 'hole', 'open-channel']); choice(v.status, 'relation.status', ['verified', 'unknown']);
    const refs = list(v.evidenceIds, 'relation.evidenceIds', 2, 16);
    if (new Set(refs).size !== refs.length || refs.some(id => !evidenceIds.has(id as string))) fail('relation', 'duplicate or missing evidence');
    if (v.status === 'verified' && refs.some(id => record.evidence.find(e => e.id === id)!.status !== 'verified')) fail('relation', 'unknown supporting evidence');
    if (v.status === 'verified') {
      const family = ['connected', 'separate'].includes(v.kind as string) ? 'connectivity' : 'enclosure';
      const key = canonicalJson([family, [...refs].sort()]), previous = relationKinds.get(key);
      if (previous && previous !== v.kind) fail('relation', 'contradictory verified relations');
      relationKinds.set(key, v.kind as string);
    }
  }
  if (record.provider.kind === 'none' && (regions.length || record.evidence.length || record.suggestions.length || record.corrections.length || record.relations.length || record.rawOutput)) fail('provider', 'None must be empty');
  if (byteLength(JSON.stringify(record)) > TEXT_LIMITS.cacheBytes) fail('cache', 'serialized size exceeds 2 MiB');
  const occupancy = new Uint8Array(source.width * source.height);
  for (const e of record.evidence) for (const [start, length] of e.runs) for (let i = start; i < start + length; i++) {
    if (!inside([i % source.width + .5, Math.floor(i / source.width) + .5], byId.get(e.regionId)!.polygon)) fail('evidence', 'pixel outside region');
    if (e.status !== 'verified') continue;
    const role = ['ink', 'outline', 'shadow', 'background'].indexOf(e.kind) + 1;
    if (occupancy[i] && occupancy[i] !== role) fail('evidence', 'conflicting source roles');
    occupancy[i] = role;
  }
  if (record.cacheKey !== textAnalysisCacheKey(source, record.provider, record.suggestions.map(s => s.provider))) fail('cacheKey', 'stale source, transform or provider configuration');
  const { contentHash, ...content } = record;
  if (contentHash !== hashJson(content)) fail('contentHash', 'analysis integrity mismatch');
}

/** Unverified regions, OCR strings and VLM proposals never become painted masks. */
function coreEvidence(record: TextAnalysis) {
  const kinds = ['ink', 'outline', 'shadow', 'background'] as const;
  return kinds.map(kind => {
    const mask = new Uint8Array(record.source.width * record.source.height);
    for (const e of record.evidence) if (e.status === 'verified' && e.kind === kind) for (const [start, length] of e.runs) mask.fill(1, start, start + length);
    const runs: [number, number][] = [];
    mask.forEach((v, i) => { if (!v) return; const last = runs[runs.length - 1]; if (last && last[0] + last[1] === i) last[1]++; else runs.push([i, 1]); });
    return { kind, runs };
  }).filter(e => e.runs.length);
}
export function textCoreEvidenceHash(record: TextAnalysis): string {
  validateTextAnalysis(record);
  const references = new Map(record.evidence.map(e => [e.id, hashJson({ kind: e.kind, runs: e.runs })]));
  const relations = [...new Set(record.relations.filter(r => r.status === 'verified').map(r => canonicalJson({ kind: r.kind, evidence: r.evidenceIds.map(id => references.get(id)!).sort() })))].sort();
  return hashJson({ source: { rgbaHash: record.source.rgbaHash, width: record.source.width, height: record.source.height }, evidence: coreEvidence(record), relations });
}

export interface TextProjectionTarget { width: number; height: number; crop?: [number, number, number, number]; phase?: [number, number]; lockedCells?: number[] }
/** Diagnostic projection only. TXT-03 will consume this evidence in proposals;
 * it does not masquerade as SourceFeatureRegion or alter manualSoft semantics. */
export function projectTextEvidence(record: TextAnalysis, image: RgbaImage, target: TextProjectionTarget) {
  validateTextAnalysis(record);
  if (image.width !== record.source.width || image.height !== record.source.height || image.data.length !== image.width * image.height * 4 || !image.data.every(v => Number.isInteger(v) && v >= 0 && v <= 255) || sha256(image.data) !== record.source.rgbaHash) fail('source', 'original RGBA is required and must match');
  for (const k of ['width', 'height'] as const) number(target[k], `target.${k}`, 1, 256, true);
  if (target.crop) {
    list(target.crop, 'target.crop', 4, 4).forEach(v => number(v, 'target.crop', 0, 4096, true));
    const [l, t, r, b] = target.crop; if (l >= r || t >= b || r > image.width || b > image.height) fail('target.crop', 'invalid crop');
  }
  if (target.phase) list(target.phase, 'target.phase', 2, 2).forEach(v => number(v, 'target.phase', -.49, .49));
  const locked = new Set(target.lockedCells ?? []); for (const i of locked) number(i, 'target.lockedCells', 0, target.width * target.height - 1, true);
  const geometry = patternGeometry(image.width, image.height, target.width, target.height, target.crop, target.phase);
  const [left, top, right, bottom] = target.crop ?? [0, 0, image.width, image.height];
  const addPixel = (values: Float64Array, i: number) => {
      const m = geometry.sourceToGrid;
      const sx = i % image.width, sy = Math.floor(i / image.width), alpha = image.data[i * 4 + 3] / 255;
      if (!alpha || sx < left || sx >= right || sy < top || sy >= bottom) return;
      const [x0, y0] = transformTextPoint(m, [sx, sy]), [x1, y1] = transformTextPoint(m, [sx + 1, sy + 1]);
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(target.height, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(target.width, Math.ceil(x1)); x++) {
        values[y * target.width + x] += alpha * Math.max(0, Math.min(x1, x + 1) - Math.max(x0, x)) * Math.max(0, Math.min(y1, y + 1) - Math.max(y0, y));
      }
  };
  const foreground = new Float64Array(target.width * target.height);
  for (let i = 0; i < image.width * image.height; i++) addPixel(foreground, i);
  const coverage = coreEvidence(record).map(e => {
    const values = new Float64Array(target.width * target.height);
    for (const [start, length] of e.runs) for (let i = start; i < start + length; i++) addPixel(values, i);
    return { kind: e.kind, cells: Array.from(values, (value, index) => ({ index, coverage: value })).filter(v => v.coverage > 1e-12) };
  });
  const supported = [...new Set(coverage.flatMap(e => e.cells.map(c => c.index)))].sort((a, b) => a - b);
  const writableCells = supported.filter(i => !locked.has(i) && foreground[i] + 1e-12 >= .5);
  const bounds = record.regions.map(r => {
    const points = r.polygon.map(p => transformTextPoint(geometry.sourceToGrid, p));
    return { regionId: r.id, width: Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])), height: Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1])),
      status: record.evidence.some(e => e.regionId === r.id && e.status === 'verified') ? 'SOURCE_EVIDENCE_AVAILABLE' : 'UNKNOWN_NO_STROKE_EVIDENCE' };
  });
  const coreHash = textCoreEvidenceHash(record);
  return { coreHash, projectionHash: hashJson({ coreHash, geometry, lockedCells: [...locked].sort((a, b) => a - b) }), geometry, coverage, writableCells, bounds };
}

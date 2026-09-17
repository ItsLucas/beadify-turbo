import type { RgbaImage, TextAnalysis } from './contracts';
import { createTextAnalysis } from './core/text-analysis';
import { hashJson, sha256 } from './core/hash';

export function resealText(value: TextAnalysis): TextAnalysis {
  const { contentHash: _hash, cacheKey: _cache, ...draft } = value;
  return createTextAnalysis(draft);
}
export function emptyTextAnalysis(image: RgbaImage): TextAnalysis {
  const identity: TextAnalysis['source']['sourceToAnalysis'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return createTextAnalysis({ schemaVersion: 1, kind: 'text-analysis',
    source: { rgbaHash: sha256(image.data), width: image.width, height: image.height, analysisWidth: image.width, analysisHeight: image.height,
      sourceToAnalysis: identity, analysisToSource: identity, preprocessingHash: hashJson({ input: 'original-rgba' }) },
    provider: { kind: 'manual', id: 'web-manual', version: '1', modelHash: null, configHash: hashJson({ version: 1 }), promptHash: null, device: 'browser' },
    regions: [], evidence: [], relations: [], suggestions: [], corrections: [], rawOutput: '' });
}
export function matchingText(value: TextAnalysis, image: RgbaImage, hash = sha256(image.data)): boolean {
  return value.source.rgbaHash === hash && value.source.width === image.width && value.source.height === image.height;
}
export async function requestTextAnalysis(_mode: 'ocr' | 'vlm', _image: RgbaImage, _value: TextAnalysis | undefined, _signal: AbortSignal): Promise<TextAnalysis> {
  throw new Error('轻量版已关闭 OCR 和 VLM');
}

/** Excluding a region also excludes all its source evidence and children. */
export function updateTextRegion(value: TextAnalysis, id: string, role: TextAnalysis['regions'][number]['role'] | 'delete'): TextAnalysis {
  const ids = new Set([id]);
  for (let pass = 0; pass < value.regions.length; pass++) for (const r of value.regions) if (r.parentId && ids.has(r.parentId)) ids.add(r.id);
  const evidence = value.evidence.filter(e => !ids.has(e.regionId));
  const retained = new Set(evidence.map(e => e.id));
  return resealText({ ...value, regions: role === 'delete' ? value.regions.filter(r => !ids.has(r.id)) : value.regions.map(r => ids.has(r.id) ? { ...r, role, status: role === 'unknown' ? 'unknown' : 'verified' } : r),
    evidence, relations: value.relations.filter(r => r.evidenceIds.every(e => retained.has(e))),
    corrections: role === 'delete' ? value.corrections.filter(c => !ids.has(c.regionId)) : value.corrections,
    suggestions: value.suggestions.filter(s => !s.regionId || !ids.has(s.regionId)) });
}

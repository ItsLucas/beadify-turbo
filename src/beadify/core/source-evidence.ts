import type { RgbaImage, SourceComponentEvidence } from '../contracts';
import { linearToOklab, srgbToLinear, type Oklab } from './color';
import type { SourceComponentIndex } from './source-components';

const LINEAR = Float64Array.from({ length: 256 }, (_, value) => srgbToLinear(value / 255));
export const sourceBinKey = (r: number, g: number, b: number): number => (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

export interface SourceModeEvidence {
  key: number;
  color: Oklab;
  weight: number;
  /** Fraction in the largest 8-connected component times its squared ROI span.
   * At least three source pixels must support a component. This is geometric
   * evidence for a coherent structure, not a semantic feature classification. */
  structuralSupport: number;
  boundarySupport?: number;
  compactSupport?: number;
  components?: SourceComponentEvidence[];
  contrast: number;
}
export interface SourceRegionEvidence {
  mean: Oklab;
  edge: number;
  contrast: number;
  reliability: number;
  modes: SourceModeEvidence[];
  /** Canonical cross-bin candidates; these do not add filtered-color mass. */
  strokeModes?: SourceModeEvidence[];
}

/** Original-image evidence uses exactly the same alpha-weighted source footprint
 * as filtered-color sampling. Transparent RGB contributes neither color nor
 * gradients. Local and optional cross-cell components never join through
 * pixels outside a crop/mask or nearly transparent bridges. Color and coverage
 * still use every nonzero alpha; topology requires alpha >= 0.5. */
export function sourceRegionEvidence(image: RgbaImage, x0: number, y0: number, x1: number, y1: number, global?: SourceComponentIndex): SourceRegionEvidence | null {
  const left = Math.max(0, Math.floor(x0)), top = Math.max(0, Math.floor(y0));
  const right = Math.min(image.width, Math.ceil(x1)), bottom = Math.min(image.height, Math.ceil(y1));
  const width = Math.max(0, right - left), height = Math.max(0, bottom - top), size = width * height;
  if (size === 0) return null;
  const keys = new Int16Array(size).fill(-1), weights = new Float64Array(size), visited = new Uint8Array(size);
  const bins = new Map<number, { key: number; weight: number; r: number; g: number; b: number; componentWeight: number; span: number; count: number }>();
  const globalMass = new Map<number, number>();
  const strokeMass = new Map<number, { total: number; byKey: Map<number, number> }>();
  let total = 0, r = 0, g = 0, b = 0, edge = 0;
  for (let sy = top; sy < bottom; sy++) {
    const overlapY = Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
    for (let sx = left; sx < right; sx++) {
      const base = 4 * (sy * image.width + sx), alpha = image.data[base + 3] / 255;
      const weight = overlapY * Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx)) * alpha;
      if (weight <= 0) continue;
      const pr = LINEAR[image.data[base]], pg = LINEAR[image.data[base + 1]], pb = LINEAR[image.data[base + 2]];
      const key = sourceBinKey(image.data[base], image.data[base + 1], image.data[base + 2]), index = (sy - top) * width + sx - left;
      if (alpha >= .5) keys[index] = key;
      weights[index] = weight;
      const component = global?.labels[sy * image.width + sx];
      if (component !== undefined && component >= 0) globalMass.set(component, (globalMass.get(component) ?? 0) + weight);
      const stroke = global?.strokes?.labels[sy * image.width + sx];
      if (stroke !== undefined && stroke >= 0 && global!.strokes!.strokes[stroke].support > .5) {
        const evidence = strokeMass.get(stroke) ?? { total: 0, byKey: new Map<number, number>() };
        evidence.total += weight; evidence.byKey.set(key, (evidence.byKey.get(key) ?? 0) + weight); strokeMass.set(stroke, evidence);
      }
      const bin = bins.get(key) ?? { key, weight: 0, r: 0, g: 0, b: 0, componentWeight: 0, span: 0, count: 0 };
      bin.weight += weight; bin.r += pr * weight; bin.g += pg * weight; bin.b += pb * weight;
      bins.set(key, bin); total += weight; r += pr * weight; g += pg * weight; b += pb * weight;
      // Include both sides of a source edge, including an edge exactly at a grid
      // boundary. Alpha edges remain occupancy evidence, not invented RGB edges.
      for (const [nx, ny] of [[sx - 1, sy], [sx + 1, sy], [sx, sy - 1], [sx, sy + 1]]) {
        if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
        const at = 4 * (ny * image.width + nx), otherAlpha = image.data[at + 3] / 255;
        if (otherAlpha <= 0) continue;
        const distance = Math.hypot(pr - LINEAR[image.data[at]], pg - LINEAR[image.data[at + 1]], pb - LINEAR[image.data[at + 2]]) / Math.sqrt(3);
        edge = Math.max(edge, distance * Math.min(alpha, otherAlpha));
      }
    }
  }
  if (total <= 0) return null;
  const queue = new Uint32Array(size);
  for (let start = 0; start < size; start++) {
    if (keys[start] < 0 || visited[start]) continue;
    const key = keys[start]; let head = 0, tail = 1, weight = 0;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    queue[0] = start; visited[start] = 1;
    while (head < tail) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      weight += weights[index]; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
        const next = (y + dy) * width + x + dx;
        if (!visited[next] && keys[next] === key) { visited[next] = 1; queue[tail++] = next; }
      }
    }
    const bin = bins.get(key)!;
    const span = clamp(Math.max(
      (Math.min(x1, left + maxX + 1) - Math.max(x0, left + minX)) / (x1 - x0),
      (Math.min(y1, top + maxY + 1) - Math.max(y0, top + minY)) / (y1 - y0),
    ));
    if (weight > bin.componentWeight || (weight === bin.componentWeight && span > bin.span)) {
      bin.componentWeight = weight; bin.span = span; bin.count = tail;
    }
  }
  const ordered = [...bins.values()].sort((a, b) => b.weight - a.weight || a.key - b.key);
  const colorOf = (bin: typeof ordered[number]): Oklab => linearToOklab({ r: bin.r / bin.weight, g: bin.g / bin.weight, b: bin.b / bin.weight });
  const dominant = colorOf(ordered[0]);
  const strokeModes: SourceModeEvidence[] = [...strokeMass].map(([id, mass]) => {
    const stroke = global!.strokes!.strokes[id], index = global!.components.length + id;
    let endpointMask = 0;
    if (!stroke.closed) stroke.endpointNeighborhoods.forEach((pixels, end) => {
      if (pixels.some(pixel => {
        const x = pixel % image.width + .5, y = Math.floor(pixel / image.width) + .5;
        return x >= x0 && x < x1 && y >= y0 && y < y1;
      })) endpointMask |= 1 << end;
    });
    return { key: -1 - index, color: stroke.color, weight: mass.total / total, structuralSupport: stroke.support,
      boundarySupport: stroke.support, compactSupport: 0, contrast: stroke.contrast,
      components: [{ id: index, coverage: clamp(mass.total / ((x1 - x0) * (y1 - y0))), support: stroke.support,
        kind: 'stroke' as const, span: stroke.span, thickness: stroke.thickness, endpointMask, closed: stroke.closed, contrast: stroke.contrast }] };
  }).sort((a, b) => b.weight * b.structuralSupport - a.weight * a.structuralSupport || a.key - b.key).slice(0, 2);
  const modes = ordered.map(bin => {
    const color = colorOf(bin);
    let boundarySupport = 0, compactSupport = 0, surroundContrast = 0;
    const components: NonNullable<SourceModeEvidence['components']> = [];
    for (const [id, mass] of globalMass) {
      const component = global!.components[id];
      if (component.key !== bin.key) continue;
      const fraction = mass / bin.weight;
      boundarySupport = Math.max(boundarySupport, fraction * component.boundarySupport);
      compactSupport = Math.max(compactSupport, fraction * component.compactSupport);
      const span = Math.max(component.right - component.left, component.bottom - component.top) * global!.scale;
      const thickness = component.area * global!.scale ** 2 / span;
      const kind = component.compactSupport > .5 ? 'compact' : span >= 1 && thickness <= .45 ? 'stroke' : component.regionSupport > .5 ? 'region' : null;
      const support = clamp(fraction * (kind === 'compact' ? component.compactSupport : kind === 'region' ? component.regionSupport : component.boundarySupport));
      if (kind && support > .5) {
        components.push({ id, coverage: clamp(mass / ((x1 - x0) * (y1 - y0))), support, kind, span, thickness, contrast: component.surroundContrast });
        if (kind === 'compact' && bin.weight / total <= .5) surroundContrast = Math.max(surroundContrast, component.surroundContrast);
      }
    }
    // When most of a raw bin belongs to one new cross-bin stroke, associate it
    // with that same canonical ID. Consumers deduplicate by ID/cell, rather
    // than counting every fragmented raw bin as another feature.
    const crossing = strokeModes.find(mode => {
      const id = mode.components![0].id - global!.components.length;
      return (strokeMass.get(id)?.byKey.get(bin.key) ?? 0) / bin.weight >= .5;
    });
    if (crossing) {
      components.length = 0; components.push(...crossing.components!);
      boundarySupport = Math.max(boundarySupport, crossing.boundarySupport ?? 0);
    }
    boundarySupport = clamp(boundarySupport); compactSupport = clamp(compactSupport);
    return { key: bin.key, color, weight: bin.weight / total,
      structuralSupport: Math.max(bin.count >= 3 ? clamp(bin.componentWeight / bin.weight * bin.span ** 2) : 0, boundarySupport, compactSupport),
      ...(global ? { boundarySupport, compactSupport, components: components.sort((a, b) => b.support * b.coverage - a.support * a.coverage || a.id - b.id).slice(0, 2) } : {}),
      contrast: clamp(Math.max(surroundContrast, Math.hypot(color.L - dominant.L, color.a - dominant.a, color.b - dominant.b))) };
  });
  const contrast = Math.max(...modes.map(mode => mode.contrast));
  // A lone high-contrast pixel can have a strong raw gradient but carries no
  // automatic geometric guarantee. A flat region is reliable evidence of no
  // internal contrast, including a one-source-pixel footprint at high zoom.
  const reliability = contrast > 1e-8 ? clamp(Math.max(...modes.map(mode => mode.contrast * mode.structuralSupport)) / contrast) : 1;
  return { mean: linearToOklab({ r: r / total, g: g / total, b: b / total }), edge: clamp(edge), contrast, reliability, modes, ...(strokeModes.length ? { strokeModes } : {}) };
}

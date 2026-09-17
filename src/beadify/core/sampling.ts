import type { PatternGeometry, RgbaImage, SourceComponentEvidence } from '../contracts';
import { linearToOklab, linearToSrgb8, srgbToLinear, type Oklab } from './color';
import { sourceBinKey, sourceRegionEvidence } from './source-evidence';
import { indexSourceComponents } from './source-components';

const LINEAR = Float64Array.from({ length: 256 }, (_, value) => srgbToLinear(value / 255));

/** Source pixel boundaries map to grid boundaries. Empty contain padding is transparent. */
export function sampleImage(image: RgbaImage, width: number, height: number, geometry: PatternGeometry, method: 'nearest' | 'area'): (Oklab | null)[] {
  const scale = geometry.sourceToGrid[0], dx = geometry.sourceToGrid[2], dy = geometry.sourceToGrid[5];
  const samples: (Oklab | null)[] = new Array(width * height).fill(null);
  const fullArea = 1 / (scale * scale);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (method === 'nearest') {
        const sx = Math.floor((x + 0.5 - dx) / scale), sy = Math.floor((y + 0.5 - dy) / scale);
        if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
        const base = 4 * (sy * image.width + sx);
        if (image.data[base + 3] / 255 < geometry.alphaCoverageThreshold) continue;
        samples[index] = linearToOklab({ r: LINEAR[image.data[base]], g: LINEAR[image.data[base + 1]], b: LINEAR[image.data[base + 2]] });
        continue;
      }
      const x0 = (x - dx) / scale, x1 = (x + 1 - dx) / scale;
      const y0 = (y - dy) / scale, y1 = (y + 1 - dy) / scale;
      let alphaArea = 0, r = 0, g = 0, b = 0;
      for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(image.height, Math.ceil(y1)); sy++) {
        const overlapY = Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
        for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(image.width, Math.ceil(x1)); sx++) {
          const overlap = overlapY * Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx));
          const base = 4 * (sy * image.width + sx);
          const weight = overlap * image.data[base + 3] / 255;
          alphaArea += weight;
          r += weight * LINEAR[image.data[base]];
          g += weight * LINEAR[image.data[base + 1]];
          b += weight * LINEAR[image.data[base + 2]];
        }
      }
      // The small tolerance only compensates arithmetic at exactly half coverage.
      if (alphaArea <= 0 || alphaArea / fullArea + 1e-12 < geometry.alphaCoverageThreshold) continue;
      samples[index] = linearToOklab({ r: r / alphaArea, g: g / alphaArea, b: b / alphaArea });
    }
  }
  return samples;
}

export type SamplingStrategy = 'dominant' | 'mean' | 'weighted-area' | 'modes';
export interface StructuredSamplingOptions {
  /** Prepared original before smoothing: same crop, mask, dimensions and alpha. */
  sourceImage?: RgbaImage;
  strategy?: SamplingStrategy;
  /** Disables all edge/structure guidance for an explicit sampling ablation. */
  sourceEdges?: boolean;
  /** Cross-bin source ridge grouping; false retains exact-bin component evidence. */
  crossBinStrokes?: boolean;
}
export interface ColorMode {
  color: Oklab;
  /** Filtered-color mass. Source-only candidates have weight 0; total remains 1. */
  weight: number;
  sourceWeight?: number;
  structuralSupport?: number;
  sourceContrast?: number;
  boundarySupport?: number;
  compactSupport?: number;
  components?: SourceComponentEvidence[];
}
export interface TargetCell {
  coverage: number;
  mean: Oklab;
  representative: Oklab;
  modes: ColorMode[];
  /** Fixed evidence from the input, never recomputed from the current assignment. */
  edge: number;
  importance: number;
  samplingStrategy?: SamplingStrategy;
  sourceMean?: Oklab;
  weightedMean?: Oklab;
  sourceEdge?: number;
  sourceContrast?: number;
  edgeReliability?: number;
  sourceDominance?: number;
  /** Fixed original pair evidence, computed before any output assignment.
   * Uncertain mixed-cell means receive a lower reliability. An interior source
   * edge is never blindly declared to be a target-grid boundary. */
  sourceRightContrast?: number;
  sourceRightReliability?: number;
  sourceDownContrast?: number;
  sourceDownReliability?: number;
}
export type TargetRaster = (TargetCell | null)[];

/** Deterministic 4-bit sRGB bins retain multiple linear-light mode centers.
 * A high-contrast minority is retained alongside the three largest bins. The
 * remaining mass is represented by one residual mean, so weights still sum to 1.
 * Pixel input deliberately bypasses region denoising and samples pixel centers.
 */
export function sampleStructuredImage(image: RgbaImage, width: number, height: number, geometry: PatternGeometry, style: 'accurate' | 'clean' | 'pixel-art' | 'pixel-input' = 'clean', options: StructuredSamplingOptions = {}): TargetRaster {
  const source = options.sourceImage ?? image;
  if (source.width !== image.width || source.height !== image.height || source.data.length !== image.data.length) {
    throw new RangeError('sampling.sourceImage: original and filtered images must have identical prepared dimensions');
  }
  if (source !== image) for (let at = 3; at < image.data.length; at += 4) if (source.data[at] !== image.data[at]) {
    throw new RangeError('sampling.sourceImage: original and filtered images must have identical prepared alpha');
  }
  const strategy = options.strategy ?? (style === 'accurate' ? 'mean' : 'modes');
  if (!['dominant', 'mean', 'weighted-area', 'modes'].includes(strategy)) throw new RangeError('sampling.strategy: unsupported strategy');
  const useEdges = options.sourceEdges !== false;
  if (style === 'pixel-input') {
    // A supplied filtered color image must not defeat Pixel Input's bypass.
    const target: TargetRaster = sampleImage(source, width, height, geometry, 'nearest').map((color, index) => {
      if (color === null) return null;
      const sx = Math.floor((index % width + 0.5 - geometry.sourceToGrid[2]) / geometry.sourceToGrid[0]);
      const sy = Math.floor((Math.floor(index / width) + 0.5 - geometry.sourceToGrid[5]) / geometry.sourceToGrid[0]);
      return { coverage: source.data[4 * (sy * source.width + sx) + 3] / 255, mean: color, representative: color, modes: [{ color, weight: 1 }], edge: 0, importance: 1, samplingStrategy: strategy, ...(useEdges ? { sourceMean: color, sourceEdge: 0, sourceContrast: 0, edgeReliability: 1, sourceDominance: 1 } : {}) };
    });
    if (useEdges) addInputEdges(target, width, height);
    return target;
  }
  const scale = geometry.sourceToGrid[0], dx = geometry.sourceToGrid[2], dy = geometry.sourceToGrid[5];
  const fullArea = 1 / (scale * scale);
  const sourceComponents = useEdges ? indexSourceComponents(source, scale, options.crossBinStrokes !== false) : undefined;
  const target: TargetRaster = new Array(width * height).fill(null);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = (x - dx) / scale, x1 = (x + 1 - dx) / scale;
    const y0 = (y - dy) / scale, y1 = (y + 1 - dy) / scale;
    const evidence = useEdges ? sourceRegionEvidence(source, x0, y0, x1, y1, sourceComponents) : null;
    const sourceModes = new Map(evidence?.modes.map(mode => [mode.key, mode]));
    const bins = new Map<number, { key: number; weight: number; r: number; g: number; b: number }>();
    let alphaArea = 0, r = 0, g = 0, b = 0, structuredArea = 0, wr = 0, wg = 0, wb = 0;
    for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(image.height, Math.ceil(y1)); sy++) {
      const overlapY = Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
      for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(image.width, Math.ceil(x1)); sx++) {
        const overlap = overlapY * Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx));
        const base = 4 * (sy * image.width + sx);
        const weight = overlap * image.data[base + 3] / 255;
        if (weight === 0) continue;
        const pr = image.data[base], pg = image.data[base + 1], pb = image.data[base + 2];
        const key = sourceBinKey(pr, pg, pb);
        const bin = bins.get(key) ?? { key, weight: 0, r: 0, g: 0, b: 0 };
        bin.weight += weight; bin.r += weight * LINEAR[pr]; bin.g += weight * LINEAR[pg]; bin.b += weight * LINEAR[pb];
        bins.set(key, bin);
        alphaArea += weight; r += weight * LINEAR[pr]; g += weight * LINEAR[pg]; b += weight * LINEAR[pb];
        const originalMode = sourceModes.get(sourceBinKey(source.data[base], source.data[base + 1], source.data[base + 2]));
        // Fixed, bounded 1..3 weighting favors spatially supported contrast. A
        // scattered minority with the same histogram receives no extra weight.
        const structuredWeight = weight * (1 + 2 * (originalMode?.structuralSupport ?? 0) * (originalMode?.contrast ?? 0));
        structuredArea += structuredWeight; wr += structuredWeight * LINEAR[pr]; wg += structuredWeight * LINEAR[pg]; wb += structuredWeight * LINEAR[pb];
      }
    }
    if (alphaArea <= 0 || alphaArea / fullArea + 1e-12 < geometry.alphaCoverageThreshold) continue;
    const ordered = [...bins.values()].sort((a, b) => b.weight - a.weight || a.key - b.key);
    const mean = linearToOklab({ r: r / alphaArea, g: g / alphaArea, b: b / alphaArea });
    const weightedMean = linearToOklab({ r: wr / structuredArea, g: wg / structuredArea, b: wb / structuredArea });
    const asColor = (bin: typeof ordered[number]) => linearToOklab({ r: bin.r / bin.weight, g: bin.g / bin.weight, b: bin.b / bin.weight });
    const dominant = asColor(ordered[0]);
    const selected = new Set(ordered.slice(0, 3));
    let minority: typeof ordered[number] | undefined, score = 0;
    for (const bin of ordered.slice(3)) {
      if (bin.weight / alphaArea < 0.02) continue;
      const color = asColor(bin);
      const contrast = Math.hypot(color.L - dominant.L, color.a - dominant.a, color.b - dominant.b);
      const candidateScore = contrast * Math.sqrt(bin.weight / alphaArea);
      if (contrast > 0.18 && candidateScore > score) { score = candidateScore; minority = bin; }
    }
    if (minority) selected.add(minority);
    const modes: ColorMode[] = [];
    let residual = 0, rr = 0, rg = 0, rb = 0;
    for (const bin of ordered) {
      if (selected.has(bin)) {
        const originalMode = sourceModes.get(bin.key);
        modes.push({ color: asColor(bin), weight: bin.weight / alphaArea,
          ...(originalMode ? { sourceWeight: originalMode.weight, structuralSupport: originalMode.structuralSupport, sourceContrast: originalMode.contrast, boundarySupport: originalMode.boundarySupport, compactSupport: originalMode.compactSupport, components: originalMode.components } : {}) });
      }
      else { residual += bin.weight; rr += bin.r; rg += bin.g; rb += bin.b; }
    }
    if (residual > 0) modes.push({ color: linearToOklab({ r: rr / residual, g: rg / residual, b: rb / residual }), weight: residual / alphaArea });
    // Preserve a bounded number of coherent ORIGINAL minority centers when a
    // smoothing pass changes their RGB bin. These are explicit candidates with
    // original coverage, not fabricated filtered-color mass or hard anchors.
    const coherentModes = (evidence?.modes ?? []).filter(mode => mode.structuralSupport >= 0.5 && mode.contrast >= 0.18 && mode.weight >= 0.02)
      .sort((a, b) => b.structuralSupport * b.contrast * Math.sqrt(b.weight) - a.structuralSupport * a.contrast * Math.sqrt(a.weight) || a.key - b.key).slice(0, 2);
    for (const originalMode of coherentModes) {
      const existing = modes.find(mode => Math.hypot(mode.color.L - originalMode.color.L, mode.color.a - originalMode.color.a, mode.color.b - originalMode.color.b) < 0.025);
      if (existing) {
        if ((existing.structuralSupport ?? 0) < originalMode.structuralSupport) Object.assign(existing, { sourceWeight: originalMode.weight, structuralSupport: originalMode.structuralSupport, sourceContrast: originalMode.contrast, boundarySupport: originalMode.boundarySupport, compactSupport: originalMode.compactSupport, components: originalMode.components });
      } else modes.push({ color: originalMode.color, weight: 0, sourceWeight: originalMode.weight, structuralSupport: originalMode.structuralSupport, sourceContrast: originalMode.contrast, boundarySupport: originalMode.boundarySupport, compactSupport: originalMode.compactSupport, components: originalMode.components });
    }
    for (const stroke of evidence?.strokeModes ?? []) {
      const existing = modes.find(mode => Math.hypot(mode.color.L - stroke.color.L, mode.color.a - stroke.color.a, mode.color.b - stroke.color.b) < .025);
      const fields = { sourceWeight: stroke.weight, structuralSupport: stroke.structuralSupport, sourceContrast: stroke.contrast,
        boundarySupport: stroke.boundarySupport, compactSupport: 0, components: stroke.components };
      if (existing) Object.assign(existing, fields);
      else modes.unshift({ color: stroke.color, weight: 0, ...fields });
    }
    target[y * width + x] = {
      coverage: Math.min(1, alphaArea / fullArea), mean, weightedMean,
      representative: strategy === 'mean' ? mean : strategy === 'weighted-area' ? weightedMean : dominant,
      modes, edge: 0, importance: 1, samplingStrategy: strategy,
      ...(evidence ? { sourceMean: evidence.mean, sourceEdge: evidence.edge, sourceContrast: evidence.contrast, edgeReliability: evidence.reliability, sourceDominance: evidence.modes[0].weight } : {}),
    };
  }
  if (useEdges) addInputEdges(target, width, height);
  return target;
}

function addInputEdges(target: TargetRaster, width: number, height: number): void {
  for (let i = 0; i < target.length; i++) {
    const cell = target[i];
    if (!cell) continue;
    let edge = (cell.sourceEdge ?? 0) * (cell.edgeReliability ?? 0);
    const x = i % width, y = Math.floor(i / width);
    const neighbors = [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y > 0 ? i - width : -1, y + 1 < height ? i + width : -1];
    for (const j of neighbors) {
      const other = target[j];
      if (other) {
        const original = cell.sourceMean ?? cell.mean, adjacent = other.sourceMean ?? other.mean;
        const contrast = Math.min(1, Math.hypot(original.L - adjacent.L, original.a - adjacent.a, original.b - adjacent.b));
        edge = Math.max(edge, contrast);
        // Mixed means cannot reliably specify the contrast of a single output
        // bead. Discount by source dominance and coherent edge confidence.
        const certainty = (value: TargetCell) => value.sourceDominance ?? Math.max(...value.modes.map(mode => mode.sourceWeight ?? mode.weight));
        const baseReliability = Math.min(cell.edgeReliability ?? 1, other.edgeReliability ?? 1) * certainty(cell) ** 2 * certainty(other) ** 2;
        // A clear ORIGINAL component need not occupy most of a target cell.
        // Its existence is reliable while the pair's mean-color contrast may
        // be ambiguous after quantization. Blend those separate confidences
        // only for supported components; unstructured texture retains the
        // conservative old guide. This depends solely on the input evidence.
        const supported = (value: TargetCell) => Math.max(0, ...value.modes.filter(mode => (mode.sourceContrast ?? 0) >= .18 && (mode.sourceWeight ?? mode.weight) + 1e-12 >= .04)
          .map(mode => Math.max(mode.boundarySupport ?? 0, mode.compactSupport ?? 0)));
        const support = Math.max(supported(cell), supported(other));
        const variance = (value: TargetCell) => { const dominant = certainty(value); return dominant * (1 - dominant) * (value.sourceContrast ?? 0) ** 2; };
        const signal = contrast ** 2, denominator = signal + variance(cell) + variance(other);
        const snr = denominator > 1e-12 ? signal / denominator : 1;
        const reliability = support >= .5 ? (1 - support) * baseReliability + support * snr : baseReliability;
        if (j === i + 1 && x + 1 < width) { cell.sourceRightContrast = contrast; cell.sourceRightReliability = reliability; }
        if (j === i + width && y + 1 < height) { cell.sourceDownContrast = contrast; cell.sourceDownReliability = reliability; }
      }
    }
    cell.edge = edge;
    cell.importance = 1 + 6 * edge;
  }
}

/** Optional fixed 3×3 bilateral pass in linear light. Alpha and occupancy are
 * unchanged; transparent RGB never bleeds into foreground. No wall-clock budget
 * or adaptive radius is involved. Callers explicitly bypass it for pixel input.
 */
export function smoothImage(image: RgbaImage): RgbaImage {
  const data = new Uint8ClampedArray(image.data);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const base = (y * image.width + x) * 4;
    if (image.data[base + 3] === 0) continue;
    const cr = LINEAR[image.data[base]], cg = LINEAR[image.data[base + 1]], cb = LINEAR[image.data[base + 2]];
    let total = 0, r = 0, g = 0, b = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const sx = x + ox, sy = y + oy;
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      const at = (sy * image.width + sx) * 4, alpha = image.data[at + 3] / 255;
      if (alpha === 0) continue;
      const nr = LINEAR[image.data[at]], ng = LINEAR[image.data[at + 1]], nb = LINEAR[image.data[at + 2]];
      const distance = (cr - nr) ** 2 + (cg - ng) ** 2 + (cb - nb) ** 2;
      const weight = alpha * Math.exp(-0.5 * (ox * ox + oy * oy) - distance / 0.02);
      total += weight; r += weight * nr; g += weight * ng; b += weight * nb;
    }
    const rgb = linearToSrgb8({ r: r / total, g: g / total, b: b / total });
    data[base] = rgb[0]; data[base + 1] = rgb[1]; data[base + 2] = rgb[2];
  }
  return { width: image.width, height: image.height, data };
}

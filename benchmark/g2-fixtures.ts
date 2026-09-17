import type { GenerationRequest, Palette, RgbaImage } from '../src/beadify/contracts/index';
import { palette as basicColors, completePalette as completeColors } from '../src/palette';
import { workspacePalette } from '../src/beadify/adapter';
import { createDetailFixtures, detailPalette } from './detail-fixtures';

type Rgb = [number, number, number];
type Point = [number, number];
export interface G2Part {
  id: string;
  kind: 'compact' | 'path';
  featureRgb: Rgb;
  backgroundRgb: Rgb;
  sourceMask: number[];
  /** All legitimate source regions of this feature color, including other parts. */
  sourceAllowedMask: number[];
  pathPoints?: Point[];
  endpoints?: [Point, Point];
}
export interface G2Fixture {
  id: string;
  family: string;
  group: 'new-synthetic' | 'new-mard' | 'anchor-45';
  negative: boolean;
  sourcePixelsPerCell: number;
  request: GenerationRequest;
  parts: G2Part[];
  negativeRegionMask?: number[];
  negativeBackgroundRgb?: Rgb;
}

/** Frozen before output inspection. These are diagnostic engineering criteria;
 * no prior accepted project gate is reopened by this G2 panel. */
export const G2_CRITERIA = Object.freeze({
  version: 'g2-criteria-v1', annotationCoverage: 0.04, acceptableColorDistance: 0.06,
  nearestColorSlack: 0.02, foregroundBackgroundDistanceRatio: 0.5,
  minimumSourceMassRecall: 0.5, minimumLargestComponentShare: 0.75,
  maximumMissingPathRun: 1, endpointNeighborhoodRadius: 0.65,
  maximumOutsideAnnotationBeads: 0, maximumUnexpectedNegativeBeads: 0,
});
export const G2_DESIGN = Object.freeze({
  version: 'g2-generator-v1', newSyntheticCases: 40, newPhysicalPaletteCases: 20, unchangedAnchorCases: 45,
  syntheticScales: [8, 12], syntheticPhases: [[0, 0], [0.35, -0.35]],
  physicalPalettes: [221, 291], physicalBudgets: [8, 12, 16, 48, 221],
  targetGrid: [8, 6], antialiasSamplesPerPixel: 16, optimization: { iterations: 6, maxEvaluations: 200000, restarts: 3, seed: 0x5eed1234 },
  criteria: G2_CRITERIA,
});
const D: Rgb = [20, 10, 0], Y: Rgb = [250, 211, 100], W: Rgb = [250, 250, 250];
const families = ['compact-light', 'compact-dark', 'enclosed-eye-glints', 'line-endpoints', 'curve-boundaries', 'diagonal-boundaries', 'scattered-specks', 'connected-clusters', 'antialiased-edge', 'lowcontrast-fabric'] as const;
type Family = typeof families[number] | 'face-details' | 'negative-texture-panel';
const distanceToSegment = (x: number, y: number, a: Point, b: Point) => {
  const t = Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)));
  return Math.hypot(x - a[0] - t * (b[0] - a[0]), y - a[1] - t * (b[1] - a[1]));
};
const pathContains = (x: number, y: number, points: Point[], width: number) => points.slice(1).some((point, i) => distanceToSegment(x, y, points[i], point) <= width / 2);
const circle = (x: number, y: number, cx: number, cy: number, radius: number) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
const ellipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const curve: Point[] = Array.from({ length: 25 }, (_, i) => [1.6 + 4.8 * i / 24, 3.35 + 0.9 * Math.sin(Math.PI * i / 24)]);
const mouth: Point[] = Array.from({ length: 25 }, (_, i) => [2.4 + 3.2 * i / 24, 3.85 + 0.62 * Math.sin(Math.PI * i / 24)]);
const clusters: Point[] = [[1.35, 1.55], [3.3, 1.8], [5.65, 1.4], [1.75, 4.55], [3.8, 4.35], [6.15, 4.65]];

function makeFixture(family: Family, scale: number, phase: Point, palette: Palette, budget: number, group: G2Fixture['group']): G2Fixture {
  const width = 8 * scale, height = 6 * scale, size = width * height;
  const negative = ['scattered-specks', 'connected-clusters', 'antialiased-edge', 'lowcontrast-fabric', 'negative-texture-panel'].includes(family);
  const background: Rgb = family === 'compact-light' ? D : Y;
  const partSpecs: Array<{ id: string; kind: G2Part['kind']; color: Rgb; background: Rgb; contains: (x: number, y: number) => boolean; path?: Point[] }> = [];
  if (family === 'compact-light' || family === 'compact-dark') partSpecs.push({ id: 'compact-dot', kind: 'compact', color: family === 'compact-light' ? W : D, background,
    contains: (x, y) => circle(x, y, 3.85, 2.9, 0.28) });
  if (family === 'enclosed-eye-glints' || family === 'face-details') {
    partSpecs.push({ id: 'left-glint', kind: 'compact', color: W, background: D, contains: (x, y) => circle(x, y, 2.62, 2.55, 0.23) },
      { id: 'right-glint', kind: 'compact', color: W, background: D, contains: (x, y) => circle(x, y, 5.0, 2.62, 0.23) });
    if (family === 'face-details') partSpecs.push({ id: 'curved-mouth', kind: 'path', color: D, background: Y, contains: (x, y) => pathContains(x, y, mouth, 0.22), path: mouth });
  }
  if (['line-endpoints', 'curve-boundaries', 'diagonal-boundaries'].includes(family)) {
    const points: Point[] = family === 'curve-boundaries' ? curve : family === 'diagonal-boundaries' ? [[1.9, 1.8], [6.2, 4.4]] : [[1.8, 2.95], [6.15, 3.15]];
    partSpecs.push({ id: 'stroke', kind: 'path', color: D, background: Y, contains: (x, y) => pathContains(x, y, points, 0.22), path: points });
  }
  const parts: G2Part[] = partSpecs.map(part => ({ id: part.id, kind: part.kind, featureRgb: [...part.color], backgroundRgb: [...part.background], sourceMask: Array(size).fill(0), sourceAllowedMask: Array(size).fill(0),
    ...(part.path ? { pathPoints: part.path.map(([x, y]) => [x * scale, y * scale] as Point), endpoints: [part.path[0].map(v => v * scale), part.path[part.path.length - 1].map(v => v * scale)] as [Point, Point] } : {}) }));
  const darkMask = Array<number>(size).fill(0), whiteMask = Array<number>(size).fill(0), negativeRegionMask = Array<number>(size).fill(0), data = new Uint8ClampedArray(size * 4);
  // Deliberately dispersed source pixels. The lattice does not share observable
  // RGBA with the isolated compact feature or the repeated compact clusters.
  const specks: Point[] = Array.from({ length: 36 }, (_, i) => [0.75 + (i * 17 % 53) / 8, 0.6 + (i * 13 % 37) / 8]);
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const index = py * width + px; let r = 0, g = 0, b = 0;
    for (let ay = 0; ay < 4; ay++) for (let ax = 0; ax < 4; ax++) {
      const x = (px + (ax + 0.5) / 4) / scale, y = (py + (ay + 0.5) / 4) / scale;
      let rgb: Rgb = background, dark = false, white = false;
      if ((family === 'enclosed-eye-glints' || family === 'face-details') && (ellipse(x, y, 2.65, 2.8, 0.85, 0.7) || ellipse(x, y, 4.98, 2.83, 0.85, 0.7))) { rgb = D; dark = true; }
      if (family === 'scattered-specks' && specks.some(([cx, cy]) => circle(x, y, cx, cy, 0.055))) { rgb = D; dark = true; }
      if (family === 'connected-clusters' && clusters.some(([cx, cy]) => circle(x, y, cx, cy, 0.2))) { rgb = D; dark = true; }
      if (family === 'antialiased-edge' && x < 3.2 + 0.23 * Math.sin(y * 1.2)) { rgb = D; dark = true; }
      const fabric = family === 'lowcontrast-fabric' || family === 'negative-texture-panel' && y > 3 && x > 3.5;
      if (fabric) { const variation = 6 * Math.sin(x * scale * 1.1) * Math.cos(y * scale * 0.85); rgb = Y.map(value => Math.max(0, Math.min(255, value + variation))) as Rgb; }
      if (family === 'negative-texture-panel') {
        if (y < 2.8 && [...clusters.slice(0, 3), [2.25, 2.2] as Point, [4.4, 2.3] as Point].some(([cx, cy]) => circle(x, y, cx, cy, 0.2))) { rgb = D; dark = true; }
        if (y > 3.2 && x < 2.4 + 0.22 * Math.sin(y * 1.2)) { rgb = D; dark = true; }
      }
      partSpecs.forEach((part, pi) => { if (part.contains(x, y)) { rgb = part.color; dark = rgb === D; white = rgb === W; parts[pi].sourceMask[index] += 1 / 16; } });
      if (dark) darkMask[index] += 1 / 16;
      if (white) whiteMask[index] += 1 / 16;
      if (negative && (family === 'antialiased-edge' ? x > 4.4 : family === 'negative-texture-panel' ? y < 2.8 || x > 4.4 : true)) negativeRegionMask[index] += 1 / 16;
      r += rgb[0] / 16; g += rgb[1] / 16; b += rgb[2] / 16;
    }
    data.set([Math.round(r), Math.round(g), Math.round(b), 255], index * 4);
  }
  parts.forEach(part => { part.sourceAllowedMask = part.featureRgb[0] > 200 ? whiteMask : darkMask; });
  const paletteLabel = palette.colors.length === 3 ? 'synth3' : `mard${palette.colors.length}`;
  return { id: `${family}-${paletteLabel}-s${scale}-p${phase.join('_')}-k${budget}`, family, group, negative, sourcePixelsPerCell: scale,
    request: { schemaVersion: 1, revision: 0, image: { width, height, data }, width: 8, height: 6, method: 'optimized', style: 'clean', maxColors: budget, palette, phase: [...phase], optimization: { ...G2_DESIGN.optimization } }, parts,
    ...(negative ? { negativeRegionMask, negativeBackgroundRgb: [...Y] as Rgb } : {}) };
}

export function createG2Fixtures(): G2Fixture[] {
  const result: G2Fixture[] = [];
  for (const family of families) for (const scale of [8, 12]) for (const phase of [[0, 0], [0.35, -0.35]] as Point[]) result.push(makeFixture(family, scale, phase, detailPalette, 3, 'new-synthetic'));
  for (const colors of [basicColors, completeColors]) for (const budget of [8, 12, 16, 48, 221]) for (const family of ['face-details', 'negative-texture-panel'] as const) result.push(makeFixture(family, 12, [0.35, -0.35], workspacePalette(colors), budget, 'new-mard'));
  for (const fixture of createDetailFixtures()) {
    const negative = fixture.kind === 'diffuse-dark-noise', scale = fixture.sourcePixelsPerCell;
    const endpoints: [Point, Point] = [[1.5 * scale, 3 * scale + Math.floor(scale / 3) + scale / 8], [6.5 * scale, 3 * scale + Math.floor(scale / 3) + scale / 8]];
    result.push({ id: `anchor-${fixture.id}`, family: fixture.kind, group: 'anchor-45', negative, sourcePixelsPerCell: scale,
      request: { ...fixture.request, optimization: { ...G2_DESIGN.optimization } },
      parts: negative ? [] : [{ id: 'anchor-feature', kind: fixture.kind === 'dark-line' ? 'path' : 'compact', featureRgb: fixture.kind === 'bright-highlight' ? W : D,
        backgroundRgb: fixture.kind === 'bright-highlight' ? D : Y, sourceMask: fixture.sourceFeatureMask, sourceAllowedMask: fixture.sourceFeatureMask,
        ...(fixture.kind === 'dark-line' ? { pathPoints: endpoints, endpoints } : {}) }],
      ...(negative ? { negativeRegionMask: Array(fixture.sourceFeatureMask.length).fill(1), negativeBackgroundRgb: Y } : {}) });
  }
  return result;
}

/** Independent analytic source-mask projection, not a core sampling call. */
export function projectG2Mask(fixture: G2Fixture, mask: readonly number[]): number[] {
  const { request, sourcePixelsPerCell: scale } = fixture, [phaseX, phaseY] = request.phase ?? [0, 0];
  const result = Array<number>(request.width * request.height).fill(0);
  for (let gy = 0; gy < request.height; gy++) for (let gx = 0; gx < request.width; gx++) {
    const x0 = (gx - phaseX) * scale, y0 = (gy - phaseY) * scale, x1 = x0 + scale, y1 = y0 + scale;
    for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(request.image.height, Math.ceil(y1)); sy++) for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(request.image.width, Math.ceil(x1)); sx++) {
      result[gy * request.width + gx] += mask[sy * request.image.width + sx] * Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx)) * Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy)) / (scale * scale);
    }
  }
  return result;
}

/** Color acceptance is frozen source-only evaluation, independent of optimizer
 * candidates or output colors. Equations are repeated here to keep the metric
 * unchanged if the production color-matching implementation changes. */
function lab(rgb: readonly number[]): number[] {
  const [r, g, b] = rgb.map(byte => { const c = byte / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b), m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b), s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
export function acceptableG2Colors(palette: Palette, feature: Rgb, background?: Rgb): string[] {
  const target = lab(feature), behind = background ? lab(background) : null, distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
  const choices = palette.colors.map(color => ({ id: color.id, feature: distance(lab(color.srgb8), target), background: behind ? distance(lab(color.srgb8), behind) : Infinity }));
  const limit = Math.max(G2_CRITERIA.acceptableColorDistance, Math.min(...choices.map(color => color.feature)) + G2_CRITERIA.nearestColorSlack);
  return choices.filter(color => color.feature <= limit && color.feature < G2_CRITERIA.foregroundBackgroundDistanceRatio * color.background).map(color => color.id).sort();
}

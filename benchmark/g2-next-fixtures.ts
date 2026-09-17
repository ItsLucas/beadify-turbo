import type { GenerationRequest, Palette, RgbaImage } from '../src/beadify/contracts';

export type Point = [number, number];
export type Rgb = [number, number, number];
export type Family = 'variable-curve' | 'variable-diagonal' | 'eye-outline-hole' | 'enclosed-accent-k6' | 'gradient-chain' | 'repeated-texture' | 'near-transparent-bridge' | 'broad-antialiased-edge';
export interface Part {
  id: string;
  kind: 'stroke' | 'outline' | 'hole' | 'accent';
  mask: number[];
  colorReferences: Rgb[];
  background: Rgb;
  path?: Point[];
  closed?: boolean;
}
export interface Fixture {
  id: string;
  family: Family;
  scale: number;
  phase: Point;
  negative: boolean;
  request: GenerationRequest;
  parts: Part[];
  negativeReferences?: Rgb[][];
}

export const CRITERIA = Object.freeze({
  version: 'g2-next-criteria-v1', sourceCoverage: .04, holeCoverage: .5,
  minimumSourceMassRecall: .5, minimumLargestComponentShare: .75,
  maximumMissingPathRun: 1, endpointRadius: .8, maximumMeanStrokeWidth: 1.75,
  maximumOutsideSourceCells: 0, maximumUnexpectedNegativeCells: 0,
  acceptableColorDistance: .10, nearestColorSlack: .025,
  foregroundBackgroundDistanceRatio: .6,
});
export const DESIGN = Object.freeze({
  version: 'g2-next-generator-v2', cases: 32, grid: [12, 9], scales: [8, 12], phases: [[0, 0], [.35, -.35]],
  maxColors: 6, optimization: { iterations: 9, maxEvaluations: 100000, restarts: 3, seed: 0x53484150 },
  annotation: 'Analytic self-authored source masks and continuous centerlines, never engine candidates or generated output.',
  criteria: CRITERIA,
});

const Y: Rgb = [245, 221, 145], W: Rgb = [250, 250, 250], D: Rgb = [34, 30, 35], P: Rgb = [213, 84, 133];
const entries: [string, Rgb][] = [
  ['D0', [20, 18, 22]], ['D1', [52, 45, 48]], ['D2', [76, 64, 68]],
  ['G0', [100, 100, 100]], ['G1', [128, 128, 128]], ['G2', [156, 156, 156]], ['G3', [184, 184, 184]], ['G4', [212, 212, 212]],
  ['Y', Y], ['W', W], ['P', P], ['C', [70, 165, 191]], ['L', [175, 194, 120]], ['O', [219, 151, 90]],
];
export const palette: Palette = { id: 'g2-next-original-14', version: '1', source: 'Original analytic regression fixtures', license: 'CC0-1.0', approximate: false,
  colors: entries.map(([id, srgb8]) => ({ id, code: id, brand: 'Test', series: 'Analytic', srgb8 })) as Palette['colors'] };
const families: Family[] = ['variable-curve', 'variable-diagonal', 'eye-outline-hole', 'enclosed-accent-k6', 'gradient-chain', 'repeated-texture', 'near-transparent-bridge', 'broad-antialiased-edge'];
const circle = (x: number, y: number, cx: number, cy: number, radius: number) => Math.hypot(x - cx, y - cy) <= radius;
function segmentDistance(x: number, y: number, a: Point, b: Point): number {
  const length = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  const t = length ? Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / length)) : 0;
  return Math.hypot(x - a[0] - t * (b[0] - a[0]), y - a[1] - t * (b[1] - a[1]));
}
function pathDistance(x: number, y: number, points: Point[]): number { return Math.min(...points.slice(1).map((b, i) => segmentDistance(x, y, points[i], b))); }
const curve: Point[] = Array.from({ length: 65 }, (_, i) => [2 + i / 8, 3.9 + .9 * Math.sin(Math.PI * i / 64)]);
const diagonal: Point[] = [[2, 2.4], [9.8, 6.4]];
const ring: Point[] = Array.from({ length: 65 }, (_, i) => [6 + 1.7 * Math.cos(i / 64 * Math.PI * 2), 4.5 + 1.7 * Math.sin(i / 64 * Math.PI * 2)]);
const strokeColors: Rgb[] = [[25, 23, 26], [40, 35, 39], [56, 46, 51], [72, 59, 64]];

function make(family: Family, scale: number, phase: Point): Fixture {
  const width = 12 * scale, height = 9 * scale, count = width * height, data = new Uint8ClampedArray(count * 4);
  const negative = ['gradient-chain', 'repeated-texture', 'near-transparent-bridge', 'broad-antialiased-edge'].includes(family);
  const parts: Part[] = [];
  if (family === 'variable-curve' || family === 'variable-diagonal') parts.push({ id: 'continuous-stroke', kind: 'stroke', mask: Array(count).fill(0), colorReferences: strokeColors, background: Y, path: family === 'variable-curve' ? curve : diagonal });
  if (family === 'eye-outline-hole') parts.push({ id: 'eye-outline', kind: 'outline', mask: Array(count).fill(0), colorReferences: [D], background: Y, path: ring, closed: true },
    { id: 'white-interior', kind: 'hole', mask: Array(count).fill(0), colorReferences: [W], background: D });
  if (family === 'enclosed-accent-k6') parts.push({ id: 'pink-interior', kind: 'accent', mask: Array(count).fill(0), colorReferences: [P], background: D });
  for (let sy = 0; sy < height; sy++) for (let sx = 0; sx < width; sx++) {
    const at = sy * width + sx; let r = 0, g = 0, b = 0, alpha = 0;
    for (let ay = 0; ay < 4; ay++) for (let ax = 0; ax < 4; ax++) {
      const x = (sx + (ax + .5) / 4) / scale, y = (sy + (ay + .5) / 4) / scale;
      let rgb: Rgb = Y, a = 255;
      if (parts[0]?.kind === 'stroke' && pathDistance(x, y, parts[0].path!) <= .17) {
        const t = (x - 2) / 8, wave = .5 + .5 * Math.sin(t * Math.PI * 3);
        rgb = [25 + 47 * wave, 23 + 36 * wave, 26 + 38 * wave]; parts[0].mask[at] += 1 / 16;
      }
      if (family === 'eye-outline-hole') {
        const radius = Math.hypot(x - 6, y - 4.5);
        if (radius <= 1.92 && radius >= 1.46) { rgb = D; parts[0].mask[at] += 1 / 16; }
        if (radius < 1.46) { rgb = W; parts[1].mask[at] += 1 / 16; }
      }
      if (family === 'enclosed-accent-k6') {
        // Broad competing gray gradients consume optional tones; retaining the
        // small chromatic accent at K6 requires prioritizing roles over shades.
        if (x < 1.6) { const grey = 100 + 100 * y / 9; rgb = [grey, grey, grey]; }
        else if (x > 10.4) { const grey = 145 + 50 * Math.sin(y / 9 * Math.PI); rgb = [grey, grey, grey]; }
        else if (y < 1.3) rgb = W;
        if (circle(x, y, 6, 4.5, 1.4)) rgb = D;
        if (circle(x, y, 6.15, 4.5, .48)) { rgb = P; parts[0].mask[at] += 1 / 16; }
      }
      if (family === 'gradient-chain') { const grey = 100 + 110 * x / 12; rgb = [grey, grey, grey]; }
      if (family === 'repeated-texture') {
        const xx = x - Math.floor(x / 1.5) * 1.5, yy = y - Math.floor(y / 1.5) * 1.5;
        if (circle(xx, yy, .75, .75, .13)) rgb = D;
      }
      if (family === 'near-transparent-bridge') {
        // Opaque endpoint islands are two source pixels each, with an almost
        // invisible line between. Alpha mass is retained; topology must not join.
        if (sy === 4 * scale && sx >= 3 * scale && sx <= 9 * scale) { rgb = D; a = sx < 3 * scale + 2 || sx > 9 * scale - 2 ? 255 : 1; }
      }
      if (family === 'broad-antialiased-edge' && x < 6.1 + .4 * Math.sin(y / 2)) rgb = D;
      r += rgb[0] * a / 255 / 16; g += rgb[1] * a / 255 / 16; b += rgb[2] * a / 255 / 16; alpha += a / 255 / 16;
    }
    data.set(alpha ? [Math.round(r / alpha), Math.round(g / alpha), Math.round(b / alpha), Math.round(alpha * 255)] : [0, 0, 0, 0], at * 4);
  }
  const image: RgbaImage = { width, height, data };
  const fixture: Fixture = { id: `${family}-s${scale}-p${phase.join('_')}`, family, scale, phase, negative, parts,
    request: { schemaVersion: 1, revision: 0, image, palette, width: 12, height: 9, method: 'optimized', style: 'clean', maxColors: 6, phase,
      optimization: { ...DESIGN.optimization } } };
  if (negative) fixture.negativeReferences = Array.from({ length: 108 }, (_, i) => {
    if (family === 'gradient-chain') { const grey = 100 + 110 * Math.max(0, Math.min(12, i % 12 + .5 - phase[0])) / 12; return [[grey, grey, grey]]; }
    if (family === 'broad-antialiased-edge') { const x = i % 12 + .5 - phase[0], y = Math.floor(i / 12) + .5 - phase[1], boundary = 6.1 + .4 * Math.sin(y / 2); return Math.abs(x - boundary) < .8 ? [D, Y] : [x < boundary ? D : Y]; }
    return [Y];
  });
  return fixture;
}
export function createFixtures(): Fixture[] { return families.flatMap(family => [8, 12].flatMap(scale => ([[0, 0], [.35, -.35]] as Point[]).map(phase => make(family, scale, phase)))); }

/** Independent analytic area projection, not the production sampling function. */
export function projectMask(fixture: Fixture, mask: readonly number[]): number[] {
  const result = Array<number>(108).fill(0), [dx, dy] = fixture.phase, s = fixture.scale;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 12; x++) {
    const x0 = (x - dx) * s, y0 = (y - dy) * s, x1 = x0 + s, y1 = y0 + s;
    for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(fixture.request.image.height, Math.ceil(y1)); sy++) for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(fixture.request.image.width, Math.ceil(x1)); sx++) {
      result[y * 12 + x] += mask[sy * fixture.request.image.width + sx] * Math.max(0, Math.min(sx + 1, x1) - Math.max(sx, x0)) * Math.max(0, Math.min(sy + 1, y1) - Math.max(sy, y0)) / (s * s);
    }
  }
  return result;
}

function lab(rgb: Rgb): number[] {
  const [r, g, b] = rgb.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b), m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b), s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, 1.9779984951 * l - 2.428592205 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .808675766 * s];
}
export function acceptedColors(references: Rgb[], background?: Rgb): string[] {
  const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, i) => value - b[i]));
  const accepted = new Set<string>();
  for (const reference of references) {
    const target = lab(reference), backdrop = background && lab(background);
    const choices = palette.colors.map(color => ({ id: color.id, distance: distance(target, lab(color.srgb8)), background: backdrop ? distance(backdrop, lab(color.srgb8)) : Infinity }));
    const limit = Math.max(CRITERIA.acceptableColorDistance, Math.min(...choices.map(color => color.distance)) + CRITERIA.nearestColorSlack);
    choices.filter(color => color.distance <= limit && color.distance < CRITERIA.foregroundBackgroundDistanceRatio * color.background).forEach(color => accepted.add(color.id));
  }
  return [...accepted].sort();
}

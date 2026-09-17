import type { GenerationRequest, Palette, RgbaImage } from '../src/beadify/contracts/index';

export type DetailKind = 'dark-line' | 'bright-highlight' | 'diffuse-dark-noise';
export interface DetailFixture {
  id: string;
  kind: DetailKind;
  sourcePixelsPerCell: number;
  featureColorId: string;
  /** Generator annotation, independent of the core's compressed color modes. */
  sourceFeatureMask: number[];
  request: GenerationRequest;
}

export const detailPalette: Palette = {
  id: 'beadify-detail-diagnostic-3', version: '1',
  source: 'Original numeric diagnostic swatches; no physical bead-color claims.',
  license: 'CC0-1.0', approximate: false,
  colors: [
    { id: 'D', code: 'D', name: 'Dark', brand: 'Synthetic', series: 'Detail', srgb8: [20, 10, 0] },
    { id: 'Y', code: 'Y', name: 'Yellow', brand: 'Synthetic', series: 'Detail', srgb8: [250, 211, 100] },
    { id: 'W', code: 'W', name: 'Light', brand: 'Synthetic', series: 'Detail', srgb8: [250, 250, 250] },
  ],
};

const phases: [number, number][] = [[0, 0], [-0.35, 0], [0.35, 0], [0, -0.35], [0, 0.35]];
const phaseId = (phase: [number, number]) => phase.map(value => value < 0 ? 'm35' : value > 0 ? 'p35' : '0').join('_');

function lineMask(scale: number): number[] {
  const width = 8 * scale, mask = new Array<number>(width * 6 * scale).fill(0);
  const top = 3 * scale + Math.floor(scale / 3);
  for (let y = top; y < top + scale / 4; y++) for (let x = 1.5 * scale; x < 6.5 * scale; x++) mask[y * width + x] = 1;
  return mask;
}

/** Redistribute the line's exact per-cell color counts over each whole source
 * cell. The stride is coprime to scale^2 for all three fixed scales, so no pixel
 * repeats. This is a deterministic texture control, not random generated noise.
 */
function scatterMask(scale: number, line: number[]): number[] {
  const width = 8 * scale, mask = new Array<number>(line.length).fill(0);
  for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 8; gx++) {
    let count = 0;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) count += line[(gy * scale + y) * width + gx * scale + x];
    for (let k = 0; k < count; k++) {
      const position = (k * (scale + 1) + gx * 3 + gy * 5) % (scale * scale);
      const x = position % scale, y = Math.floor(position / scale);
      mask[(gy * scale + y) * width + gx * scale + x] = 1;
    }
  }
  return mask;
}

function makeImage(scale: number, kind: DetailKind, mask: number[]): RgbaImage {
  const background = kind === 'bright-highlight' ? detailPalette.colors[0].srgb8 : detailPalette.colors[1].srgb8;
  const feature = kind === 'bright-highlight' ? detailPalette.colors[2].srgb8 : detailPalette.colors[0].srgb8;
  return { width: 8 * scale, height: 6 * scale, data: mask.flatMap(value => [...(value ? feature : background), 255]) };
}

export function createDetailFixtures(): DetailFixture[] {
  const fixtures: DetailFixture[] = [];
  for (const scale of [8, 12, 16]) {
    const line = lineMask(scale), highlight = new Array<number>(line.length).fill(0);
    for (let y = 2.5 * scale; y < 3 * scale; y++) for (let x = 3.5 * scale; x < 4 * scale; x++) highlight[y * 8 * scale + x] = 1;
    const masks: Record<DetailKind, number[]> = { 'dark-line': line, 'bright-highlight': highlight, 'diffuse-dark-noise': scatterMask(scale, line) };
    for (const kind of ['dark-line', 'bright-highlight', 'diffuse-dark-noise'] as const) for (const phase of phases) {
      const mask = masks[kind];
      fixtures.push({ id: `${kind}-s${scale}-p${phaseId(phase)}`, kind, sourcePixelsPerCell: scale,
        featureColorId: kind === 'bright-highlight' ? 'W' : 'D', sourceFeatureMask: mask,
        request: { schemaVersion: 1, revision: 0, image: makeImage(scale, kind, mask), width: 8, height: 6,
          method: 'optimized', style: 'clean', maxColors: 3, palette: detailPalette, phase: [...phase] },
      });
    }
  }
  return fixtures;
}

/** Independent analytic annotation projection. These fixed fixtures have exact
 * integer downscale ratios and no contain padding, so target coordinates follow
 * directly from the stated scale and phase rather than a core sampling helper.
 */
export function projectedFeatureCoverage(fixture: DetailFixture): number[] {
  const { sourcePixelsPerCell: scale, sourceFeatureMask: mask, request } = fixture;
  const [px, py] = request.phase!;
  const result = new Array<number>(request.width * request.height).fill(0);
  for (let gy = 0; gy < request.height; gy++) for (let gx = 0; gx < request.width; gx++) {
    const x0 = (gx - px) * scale, x1 = x0 + scale, y0 = (gy - py) * scale, y1 = y0 + scale;
    let mass = 0;
    for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(request.image.height, Math.ceil(y1)); sy++) {
      const overlapY = Math.max(0, Math.min(y1, sy + 1) - Math.max(y0, sy));
      for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(request.image.width, Math.ceil(x1)); sx++) {
        if (mask[sy * request.image.width + sx]) mass += overlapY * Math.max(0, Math.min(x1, sx + 1) - Math.max(x0, sx));
      }
    }
    result[gy * request.width + gx] = mass / (scale * scale);
  }
  return result;
}

import type { GenerationRequest, RgbaImage, TextRegion } from '../src/beadify/contracts';
import { workspacePalette } from '../src/beadify/adapter';
import { basicPalette } from '../src/palette';

type Point = [number, number];
type Stroke = { points: Point[]; width: number };
type Rgb = [number, number, number];
export const TEXT_DESIGN = Object.freeze({ version: 'text-diagnostics-v1', widths: [40, 62, 80, 100],
  palette: 'MARD221', maxColors: 221, phase: [0, 0], crop: 'full source frame',
  optimization: { iterations: 6, maxEvaluations: 200000, restarts: 1, seed: 20260917 },
  independentSources: 8, positiveSources: 5, negativeSources: 3,
  matching: { polygonIoU: .5, policy: 'one-to-one maximum-IoU matching; ties by regionId; unmatched known source text remains a miss',
    transcription: 'Unicode NFC, no case/space/punctuation removal; CER uses independently confirmed source strings; unknown source spans reported separately' },
  geometry: { sourceSupport: .04, backgroundSupport: .5, minimumInkMassRecall: .5, maximumUnsupportedAddedCells: 0,
    minimumBackgroundRecall: .5, maximumNewBrokenConnections: 0, maximumNewBridges: 0,
    policy: 'Keep individual metrics. Freeze source widths/gaps before output; no global quality PASS from color recall. Character readability requires independent transcription.' },
  defaultGate: 'All hard conditions pass, no new severe shape or nontext regressions, independent holdout fidelity/readability gain; this development panel cannot enable a default.',
  provenance: 'Original analytic path drawings authored for this repository, CC0-1.0; no font files, OCR, model or generated pattern supplies source labels.' });

function distance(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length)) : 0;
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
const box = (x: number, y: number, w: number, h: number): Point[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const ring = (x: number, y: number, r: number): Point[] => Array.from({ length: 33 }, (_, i) => [x + Math.cos(i * Math.PI / 16) * r, y + Math.sin(i * Math.PI / 16) * r]);
const specifications: { id: string; text: string; strokes: Stroke[]; ink?: Rgb; outline?: number; shadow?: Point; negative?: boolean; minimumGap: number; note: string }[] = [
  { id: 'han-holes', text: '口日', strokes: [{ points: box(32, 24, 64, 80), width: 8 }, { points: box(152, 24, 64, 80), width: 8 }, { points: [[152, 64], [216, 64]], width: 8 }], minimumGap: 32, note: 'Two separate glyphs; one and two enclosed spaces.' },
  { id: 'disconnected-han', text: '小', strokes: [{ points: [[130, 18], [130, 104], [116, 98]], width: 7 }, { points: [[95, 49], [71, 86]], width: 7 }, { points: [[166, 49], [188, 85]], width: 7 }], minimumGap: 22, note: 'Three disconnected source strokes; never require whole character connectivity.' },
  { id: 'colored-outline-shadow', text: '口', strokes: [{ points: box(83, 24, 84, 78), width: 8 }], ink: [230, 97, 142], outline: 4, shadow: [6, 5], minimumGap: 60, note: 'Colored face, dark outline and offset shadow retain distinct source roles.' },
  { id: 'slanted-latin', text: 'HI', strokes: [{ points: [[63, 24], [45, 104]], width: 7 }, { points: [[113, 24], [95, 104]], width: 7 }, { points: [[54, 64], [104, 64]], width: 7 }, { points: [[185, 24], [167, 104]], width: 7 }], ink: [66, 134, 186], minimumGap: 42, note: 'Original shear is retained; no upright re-render.' },
  { id: 'subgrid-thin-latin', text: 'HI', strokes: [{ points: [[48, 40], [48, 88]], width: 1.2 }, { points: [[76, 40], [76, 88]], width: 1.2 }, { points: [[48, 64], [76, 64]], width: 1.2 }, { points: [[158, 40], [158, 88]], width: 1.2 }], minimumGap: 26.8, note: 'Subcell strokes at every frozen width; report resolution sensitivity before output, not OCR exemption.' },
  { id: 'negative-face', text: '', strokes: [{ points: ring(82, 46, 14), width: 6 }, { points: ring(174, 46, 14), width: 6 }, { points: [[78, 82], [105, 98], [148, 98], [177, 80]], width: 6 }], negative: true, minimumGap: 20, note: 'Eyes and smile are artwork, not O letters or a text line.' },
  { id: 'negative-texture', text: '', strokes: Array.from({ length: 12 }, (_, i) => ({ points: [[24 + i * 18, 28], [32 + i * 18, 94]] as Point[], width: 2 })), negative: true, minimumGap: 14, note: 'Repeated decorative stripes, not repeated I characters.' },
  { id: 'negative-emblem', text: '', strokes: [{ points: [[60, 64], [104, 20], [150, 64], [104, 108], [60, 64]], width: 7 }, { points: ring(167, 65, 29), width: 7 }], ink: [137, 66, 219], negative: true, minimumGap: 6, note: 'Geometric emblem with overlapping shapes; no transcription or deletion.' },
];
export interface TextFixture { id: string; image: RgbaImage; region: TextRegion; negative: boolean; sourceLabels: {
  origin: string; minimumStrokeWidth: number; minimumGap: number; note: string;
  strokes: Stroke[]; masks: { kind: 'ink' | 'outline' | 'shadow' | 'background'; runs: [number, number][] }[];
} }
export function createTextFixtures(): TextFixture[] {
  return specifications.map(spec => {
    const width = 256, height = 128, data = new Uint8ClampedArray(width * height * 4), masks = Array.from({ length: 4 }, () => new Uint8Array(width * height));
    const nearest = (x: number, y: number) => Math.min(...spec.strokes.map(s => Math.min(...s.points.slice(1).map((b, i) => distance(x, y, s.points[i], b))) - s.width / 2));
    const classify = (x: number, y: number): number => {
      const d = nearest(x, y);
      if (d <= 0) return 0;
      if (spec.outline && d <= spec.outline) return 1;
      if (spec.shadow && nearest(x - spec.shadow[0], y - spec.shadow[1]) <= (spec.outline ?? 0)) return 2;
      return 3;
    };
    const colors: Rgb[] = [spec.ink ?? [35, 39, 43], [28, 27, 32], [130, 139, 151], [249, 247, 236]];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const rgb = colors[classify(x + (sx + .5) / 4, y + (sy + .5) / 4)];
        rgb.forEach((v, k) => sums[k] += v / 16);
      }
      data.set([...sums.map(Math.round), 255], (y * width + x) * 4);
      if (x >= 12 && x < 244 && y >= 8 && y < 120) masks[classify(x + .5, y + .5)][y * width + x] = 1;
    }
    const kinds = ['ink', 'outline', 'shadow', 'background'] as const;
    return { id: spec.id, image: { width, height, data }, negative: !!spec.negative,
      region: { id: `${spec.id}-region`, parentId: null, polygon: [[12, 8], [244, 8], [244, 120], [12, 120]], granularity: spec.negative ? 'unknown' : 'line', role: spec.negative ? 'artwork' : 'text',
        status: 'verified', transcription: spec.text, detectionScore: null, recognitionScore: null, alignment: 'manual', readingOrder: 0, angle: null },
      sourceLabels: { origin: TEXT_DESIGN.provenance, minimumStrokeWidth: Math.min(...spec.strokes.map(s => s.width)), minimumGap: spec.minimumGap, note: spec.note, strokes: spec.strokes,
        masks: spec.negative ? [] : masks.map((mask, i) => {
          const runs: [number, number][] = [];
          mask.forEach((v, at) => { if (!v) return; const last = runs[runs.length - 1]; if (last && last[0] + last[1] === at) last[1]++; else runs.push([at, 1]); });
          return { kind: kinds[i], runs };
        }).filter(mask => mask.runs.length) } };
  });
}
export function textFixtureRequest(image: RgbaImage, width: number): GenerationRequest {
  return { schemaVersion: 1, revision: 0, image, palette: workspacePalette(basicPalette), width, height: Math.ceil(image.height / image.width * width),
    maxColors: 221, method: 'optimized', style: 'clean', phase: [0, 0], optimization: { ...TEXT_DESIGN.optimization } };
}

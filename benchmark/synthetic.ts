import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { GenerationRequest, Palette } from '../src/beadify/contracts/index';

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];
type Pixel = (x: number, y: number, width: number, height: number) => Rgb | Rgba;

const colors: Array<[string, Rgb]> = [
  ['Black', [0, 0, 0]], ['White', [255, 255, 255]], ['Red', [230, 48, 58]],
  ['Orange', [245, 142, 40]], ['Yellow', [250, 215, 55]], ['Green', [50, 155, 80]],
  ['Mint', [120, 205, 175]], ['Blue', [45, 100, 210]], ['Sky', [110, 185, 235]],
  ['Purple', [130, 75, 170]], ['Pink', [235, 135, 170]], ['Brown', [125, 80, 50]],
  ['Tan', [210, 175, 125]], ['Light gray', [205, 205, 205]], ['Gray', [125, 125, 125]],
  ['Dark gray', [55, 55, 55]],
];

export const syntheticPalette: Palette = {
  id: 'beadify-synthetic-16',
  version: '1',
  source: 'Original synthetic test swatches; no manufacturer or measured bead-color claims.',
  license: 'CC0-1.0',
  approximate: true,
  colors: colors.map(([name, srgb8], index) => {
    const code = `C${String(index + 1).padStart(2, '0')}`;
    return { id: `Synthetic/Test/${code}`, brand: 'Synthetic', series: 'Test', code, name, srgb8 };
  }) as Palette['colors'],
};

const [black, white, red, orange, yellow, green, mint, blue, sky, purple, pink, brown, tan, lightGray, gray, darkGray] = colors.map(([, rgb]) => rgb);
const clear: Rgba = [0, 0, 0, 0];
const circle = (x: number, y: number, cx: number, cy: number, radius: number) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
const ellipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const rect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((value, channel) => Math.round(value * (1 - t) + b[channel] * t)) as Rgb;
const distanceToSegment = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
};

interface FixtureSpec {
  id: string;
  title: string;
  tags: string[];
  inspect: string;
  pixel: Pixel;
  width?: number;
  height?: number;
  gridWidth?: number;
  gridHeight?: number;
  maxColors?: number;
}

const specs: FixtureSpec[] = [
  { id: '01-primary-swatches', title: 'Opaque primary swatches', tags: ['primaries', 'white', 'opaque'], inspect: 'White is a bead color; it must not become empty.', maxColors: 8,
    pixel: (x, y) => [black, white, red, green, blue, yellow, pink, gray][Math.floor(y / 32) * 4 + Math.floor(x / 16)] },
  { id: '02-wire-fence', title: 'Thin wire fence', tags: ['thin-lines', 'phase', 'line-art'], inspect: 'Inspect aliasing of one-pixel horizontal and vertical wires.', maxColors: 2,
    pixel: (x, y) => x % 9 === 2 || y % 11 === 3 ? black : white },
  { id: '03-diagonal-kite', title: 'Kite and diagonal string', tags: ['diagonal', 'thin-lines', 'toy'], inspect: 'Inspect the narrow diagonal string and diamond corners.', maxColors: 4,
    pixel: (x, y) => Math.abs(x - 36) + Math.abs(y - 18) < 15 ? (x < 36 ? red : yellow) : distanceToSegment(x, y, 36, 33, 13, 61) < 0.7 ? darkGray : sky },
  { id: '04-white-eye-face', title: 'Dark face with eye whites', tags: ['eyes', 'white', 'small-features'], inspect: 'Eye whites and pupils are distinct from empty background.', maxColors: 4,
    pixel: (x, y) => {
      if (!ellipse(x, y, 32, 32, 25, 28)) return clear;
      if (circle(x, y, 23, 26, 2) || circle(x, y, 42, 26, 2)) return black;
      if (ellipse(x, y, 22, 26, 5, 6) || ellipse(x, y, 41, 26, 5, 6)) return white;
      if (rect(x, y, 25, 43, 40, 45)) return pink;
      return darkGray;
    } },
  { id: '05-transparent-ghost', title: 'White ghost on transparency', tags: ['white', 'transparency', 'silhouette'], inspect: 'The opaque white body must remain distinct from transparency.', maxColors: 2,
    pixel: (x, y) => {
      const body = ellipse(x, y, 32, 27, 19, 22) || rect(x, y, 13, 27, 52, 47 + 5 * Math.sin(x / 5));
      if (!body) return clear;
      return ellipse(x, y, 25, 26, 2, 4) || ellipse(x, y, 39, 26, 2, 4) ? black : white;
    } },
  { id: '06-curled-tail-cat', title: 'Cat with curled narrow tail', tags: ['tail', 'animal', 'connectivity'], inspect: 'Inspect tail attachment and isolated tail-tip cells; no survival guarantee below grid resolution.', maxColors: 4,
    pixel: (x, y) => {
      const tail = Math.abs(Math.hypot(x - 48, y - 40) - 10) < 1.7 && (x > 48 || y > 40);
      if (tail) return orange;
      if (ellipse(x, y, 29, 40, 13, 18)) return orange;
      const ear = y >= 10 && y < 23 && (Math.abs(x - 21) < (y - 8) / 3 || Math.abs(x - 37) < (y - 8) / 3);
      if (circle(x, y, 29, 25, 13) || ear) return circle(x, y, 24, 24, 1.5) || circle(x, y, 34, 24, 1.5) ? black : orange;
      return clear;
    } },
  { id: '07-sunset-gradient', title: 'Sunset gradient over water', tags: ['gradient', 'landscape', 'limited-palette'], inspect: 'Inspect gradient banding and the sun with an eight-color budget.', maxColors: 8,
    pixel: (x, y) => circle(x, y, 35, 27, 10) ? yellow : y < 40 ? mix(purple, orange, y / 40) : mix(blue, mint, (y - 40) / 24) },
  { id: '08-app-envelope', title: 'Envelope app icon', tags: ['icon', 'diagonal', 'flat-color'], inspect: 'Inspect the envelope folds and rounded-looking outer silhouette.', maxColors: 3,
    pixel: (x, y) => {
      if (!rect(x, y, 5, 5, 59, 59)) return clear;
      if (!rect(x, y, 13, 19, 51, 45)) return blue;
      return Math.abs(y - (20 + Math.min(x - 13, 50 - x) * 0.6)) < 1.4 ? blue : white;
    } },
  { id: '09-low-contrast-cloud', title: 'Low-contrast cloud', tags: ['low-contrast', 'soft-boundary', 'cloud'], inspect: 'Inspect merging of cloud, shadow, and light gray background.', maxColors: 4,
    pixel: (x, y) => circle(x, y, 22, 34, 13) || circle(x, y, 35, 26, 16) || circle(x, y, 47, 35, 12) ? (y > 39 ? [198, 204, 211] : [223, 226, 231]) : [207, 215, 223] },
  { id: '10-wide-skyline', title: 'Wide skyline', tags: ['wide', 'architecture', 'small-windows'], inspect: 'Inspect 3:1 framing and small window loss.', width: 96, height: 32, gridWidth: 30, gridHeight: 10, maxColors: 5,
    pixel: (x, y) => {
      const roof = [14, 8, 18, 4, 11, 16, 6, 13][Math.floor(x / 12)];
      return y < roof ? sky : x % 12 > 3 && x % 12 < 7 && y > roof + 3 && y % 6 < 2 ? yellow : darkGray;
    } },
  { id: '11-tall-flower', title: 'Tall stem and flower', tags: ['tall', 'plant', 'thin-stem'], inspect: 'Inspect 1:3 framing and stem connectivity.', width: 32, height: 96, gridWidth: 10, gridHeight: 30, maxColors: 4,
    pixel: (x, y) => {
      if (circle(x, y, 16, 18, 5)) return yellow;
      if ([0, 1, 2, 3, 4, 5].some((i) => circle(x, y, 16 + 8 * Math.cos(i * Math.PI / 3), 18 + 8 * Math.sin(i * Math.PI / 3), 5))) return pink;
      return rect(x, y, 15, 24, 18, 92) || ellipse(x, y, 10, 52, 8, 3) || ellipse(x, y, 22, 68, 8, 3) ? green : clear;
    } },
  { id: '12-checker-cloth', title: 'Offset checker cloth', tags: ['texture', 'phase', 'checkerboard'], inspect: 'Inspect loss of 3-pixel checks at the target grid phase.', maxColors: 4,
    pixel: (x, y) => (Math.floor((x + 1) / 3) + Math.floor((y + 2) / 3)) % 2 ? blue : white },
  { id: '13-ring-pendant', title: 'Ring pendant with hole', tags: ['holes', 'jewelry', 'transparency'], inspect: 'The central hole is transparent; inspect ring thickness.', maxColors: 3,
    pixel: (x, y) => {
      const radius = Math.hypot(x - 32, y - 34);
      return radius > 13 && radius < 23 || rect(x, y, 29, 4, 35, 15) ? (x + y < 58 ? yellow : orange) : clear;
    } },
  { id: '14-alpha-jellyfish', title: 'Jellyfish with alpha ramp', tags: ['alpha', 'tentacles', 'coverage'], inspect: 'Inspect the 50 percent foreground-coverage cutoff and narrow tentacles.', maxColors: 4,
    pixel: (x, y) => {
      if (ellipse(x, y, 32, 28, 23, 20) && y < 31) return [110, 185, 235, Math.round(255 * (x / 63))];
      return y >= 31 && y < 59 && Math.abs((x + 2 * Math.sin(y / 5)) % 11 - 5) < 1.3 ? [130, 75, 170, 170] : clear;
    } },
  { id: '15-pixel-robot', title: 'Pixel robot', tags: ['pixel-art', 'eyes', 'orthogonal'], inspect: 'Inspect exact block alignment and eye separation.', maxColors: 5,
    pixel: (x, y) => {
      const px = Math.floor(x / 4), py = Math.floor(y / 4);
      if (rect(px, py, 4, 2, 12, 7)) return (px === 6 || px === 9) && py === 4 ? red : lightGray;
      if (rect(px, py, 5, 8, 11, 13)) return px === 7 && py === 10 ? yellow : blue;
      if (rect(px, py, 2, 8, 4, 12) || rect(px, py, 12, 8, 14, 12) || rect(px, py, 5, 13, 7, 15) || rect(px, py, 9, 13, 11, 15)) return darkGray;
      return clear;
    } },
  { id: '16-mountain-lake', title: 'Mountain and lake', tags: ['landscape', 'sloped-boundary', 'reflection'], inspect: 'Inspect snowcaps and the lake shoreline.', maxColors: 7,
    pixel: (x, y) => {
      const ridge = Math.min(18 + Math.abs(x - 20) * 0.8, 10 + Math.abs(x - 45) * 1.1);
      if (y > 43) return y % 7 === 0 ? mint : blue;
      return y < ridge ? sky : y < ridge + 4 && y < 25 ? white : y > 37 ? green : gray;
    } },
  { id: '17-citrus-slice', title: 'Citrus slice', tags: ['food', 'radial', 'thin-dividers'], inspect: 'Inspect radial white membranes and orange rind.', maxColors: 4,
    pixel: (x, y) => {
      const radius = Math.hypot(x - 32, y - 32);
      if (radius > 26) return clear;
      if (radius > 23) return orange;
      const theta = Math.atan2(y - 32, x - 32);
      return radius > 21 || radius < 3 || Math.abs(Math.sin(theta * 4)) * radius < 1 ? white : yellow;
    } },
  { id: '18-glasses-portrait', title: 'Stylized glasses portrait', tags: ['portrait', 'thin-rims', 'eyes'], inspect: 'Inspect glasses bridge, rims, and white eyes.', maxColors: 6,
    pixel: (x, y) => {
      if (!ellipse(x, y, 32, 32, 23, 29)) return sky;
      if (y < 16 + 5 * Math.sin(x / 8)) return brown;
      const lens = Math.min(Math.hypot(x - 23, y - 29), Math.hypot(x - 42, y - 29));
      if (Math.abs(lens - 7) < 1.3 || rect(x, y, 29, 27, 36, 29)) return black;
      if (circle(x, y, 24, 29, 1.5) || circle(x, y, 41, 29, 1.5)) return black;
      if (ellipse(x, y, 24, 29, 3, 2) || ellipse(x, y, 41, 29, 3, 2)) return white;
      return rect(x, y, 26, 45, 39, 47) ? red : tan;
    } },
  { id: '19-woven-basket', title: 'Woven basket', tags: ['texture', 'object', 'handle'], inspect: 'Inspect alternating weave and narrow curved handle.', maxColors: 5,
    pixel: (x, y) => {
      if (Math.abs(Math.hypot(x - 32, y - 27) - 20) < 2.5 && y < 30) return brown;
      if (y >= 28 && y <= 57 && x >= 8 + (y - 28) / 5 && x <= 56 - (y - 28) / 5) return (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? tan : brown;
      return clear;
    } },
  { id: '20-letter-sign', title: 'Two-letter block sign', tags: ['text', 'small-features', 'icon'], inspect: 'Inspect counters of the hand-drawn B and E block letters.', maxColors: 3,
    pixel: (x, y) => {
      const bx = Math.floor((x - 10) / 4), by = Math.floor((y - 18) / 4);
      const letters = ['11110011111', '10001010000', '10001010000', '11110011110', '10001010000', '10001010000', '11110011111'];
      return bx >= 0 && bx < 11 && by >= 0 && by < 7 && letters[by][bx] === '1' ? white : rect(x, y, 4, 10, 60, 55) ? green : clear;
    } },
  { id: '21-key-silhouette', title: 'Key with negative space', tags: ['negative-space', 'holes', 'thin-shaft'], inspect: 'Inspect the circular opening, shaft attachment, and teeth.', maxColors: 2,
    pixel: (x, y) => {
      const ring = Math.hypot(x - 20, y - 20);
      return ring >= 7 && ring < 13 || distanceToSegment(x, y, 29, 29, 50, 50) < 2.3 || rect(x, y, 44, 49, 48, 56) || rect(x, y, 50, 49, 54, 54) ? yellow : clear;
    } },
  { id: '22-butterfly', title: 'Butterfly with fine antennae', tags: ['animal', 'symmetry', 'antennae'], inspect: 'Inspect antennae and the four separated wing lobes.', maxColors: 5,
    pixel: (x, y) => {
      if (rect(x, y, 31, 20, 34, 52) || distanceToSegment(x, y, 32, 24, 23, 11) < 0.8 || distanceToSegment(x, y, 32, 24, 41, 11) < 0.8) return black;
      if (ellipse(x, y, 20, 29, 13, 16) || ellipse(x, y, 45, 29, 13, 16)) return circle(x, y, x < 32 ? 18 : 47, 27, 4) ? yellow : purple;
      return ellipse(x, y, 23, 46, 10, 11) || ellipse(x, y, 42, 46, 10, 11) ? pink : clear;
    } },
  { id: '23-odd-frame-fish', title: 'Fish in an odd-sized frame', tags: ['odd-dimensions', 'animal', 'tail'], inspect: 'Inspect explicitly recorded contain transform and narrow tail connection.', width: 71, height: 53, gridWidth: 19, gridHeight: 14, maxColors: 5,
    pixel: (x, y) => {
      if (circle(x, y, 24, 23, 1.5)) return black;
      if (circle(x, y, 24, 23, 3)) return white;
      return ellipse(x, y, 33, 27, 20, 12) || x >= 49 && x < 64 && Math.abs(y - 27) < (x - 48) * 0.8 ? orange : blue;
    } },
  { id: '24-hidden-rgb', title: 'Opaque badge and hidden RGB', tags: ['transparent-rgb', 'alpha-edge', 'icon'], inspect: 'Invisible saturated RGB must not tint opaque white or create foreground cells.', maxColors: 3,
    pixel: (x, y) => {
      const radius = Math.hypot(x - 32, y - 32);
      if (radius > 24) return [255, (x * 17 + y * 3) % 256, 255, 0];
      if (radius > 22) return [255, 255, 255, 100];
      return Math.abs(x - 32) < 3 || Math.abs(y - 32) < 3 ? red : white;
    } },
];

export interface SyntheticFixture {
  id: string;
  title: string;
  tags: string[];
  inspect: string;
  request: GenerationRequest;
}

export function createSyntheticFixtures(): SyntheticFixture[] {
  return specs.map((spec) => {
    const width = spec.width ?? 64, height = spec.height ?? 64;
    const data: number[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = spec.pixel(x, y, width, height);
        data.push(pixel[0], pixel[1], pixel[2], pixel[3] ?? 255);
      }
    }
    return {
      id: spec.id, title: spec.title, tags: spec.tags, inspect: spec.inspect,
      request: { schemaVersion: 1, revision: 0, image: { width, height, data }, width: spec.gridWidth ?? 16, height: spec.gridHeight ?? 16, palette: syntheticPalette, method: 'area', maxColors: spec.maxColors ?? 8 },
    };
  });
}

export function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, payload: Buffer): Buffer {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, payload])));
  return Buffer.concat([length, type, payload, checksum]);
}

export function rgbaToPng(width: number, height: number, data: ArrayLike<number>): Buffer {
  if (data.length !== width * height * 4) throw new Error('RGBA byte count does not match PNG dimensions');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // Eight-bit RGBA; no color profile or decoder-dependent metadata.
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width * 4; x += 1) scanlines[y * (width * 4 + 1) + 1 + x] = data[y * width * 4 + x];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

export async function writeSyntheticFixtures(repositoryRoot: string, fixtures: SyntheticFixture[]): Promise<void> {
  const directory = path.join(repositoryRoot, 'benchmark', 'fixtures');
  await mkdir(directory, { recursive: true });
  const paletteText = `${JSON.stringify(syntheticPalette, null, 2)}\n`;
  await writeFile(path.join(repositoryRoot, 'benchmark', 'palette.json'), paletteText);
  const cases = [];
  for (const fixture of fixtures) {
    const requestText = `${JSON.stringify(fixture.request)}\n`;
    const { width, height, data } = fixture.request.image;
    const png = rgbaToPng(width, height, data);
    const input = `benchmark/fixtures/${fixture.id}.request.json`;
    const sourcePng = `benchmark/fixtures/${fixture.id}.png`;
    await writeFile(path.join(repositoryRoot, input), requestText);
    await writeFile(path.join(repositoryRoot, sourcePng), png);
    cases.push({
      id: fixture.id, originalImageId: fixture.id, title: fixture.title, tags: fixture.tags,
      split: 'exploration', synthetic: true, public: true, license: 'CC0-1.0',
      source: 'Original deterministic geometry authored in benchmark/synthetic.ts; no external image assets.',
      input, sourcePng, inputFileHash: sha256(requestText), sourcePngHash: sha256(png), rgbaHash: sha256(Uint8Array.from(data)),
      sourceFrame: { width, height, orientation: 'already-upright', crop: [0, 0, width, height] },
      targetGrid: { width: fixture.request.width, height: fixture.request.height, fit: 'contain' },
      paletteId: syntheticPalette.id, paletteFileHash: sha256(paletteText), maxColors: fixture.request.maxColors,
      inspectionNotes: fixture.inspect,
      handAnnotatedRegions: [],
      constraints: ['All cells reference the frozen palette or are null.', 'BOM counts equal the number of nonempty cells.', 'Used colors do not exceed maxColors.'],
    });
  }
  const manifest = {
    schemaVersion: 1,
    dataset: 'beadify-original-synthetic-exploration-v1',
    generator: 'benchmark/synthetic.ts',
    reproduce: 'npm exec tsx scripts/benchmark.ts -- --fixtures-only',
    limitations: ['These are original synthetic exploratory fixtures, not real photographs.', 'There is no independent holdout, human preference evaluation, or private attachment in this set.', 'The synthetic palette is not a calibrated manufacturer bead palette.', 'Visual inspection notes are prompts, not expected quality scores or automatic pass assertions.'],
    palette: 'benchmark/palette.json', paletteFileHash: sha256(paletteText), cases,
  };
  await writeFile(path.join(repositoryRoot, 'benchmark', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

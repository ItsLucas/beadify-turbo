import type { RgbaImage } from '../contracts';
import { linearToOklab, srgbToLinear, type Oklab } from './color';

export interface SourceStroke {
  pixels: number[];
  left: number; top: number; right: number; bottom: number;
  area: number;
  color: Oklab;
  contrast: number;
  support: number;
  span: number;
  thickness: number;
  endpoints: [number, number];
  /** Source-connected endpoint witnesses, bounded to half a bead along the
   * source graph. They add no area and never leave the accepted stroke. */
  endpointNeighborhoods: [number[], number[]];
  closed: boolean;
}
export interface SourceStrokeIndex { labels: Int32Array; strokes: SourceStroke[] }
const NORMALS = [[1, 0], [1, 1], [0, 1], [-1, 1]] as const;
const LINEAR = Float64Array.from({ length: 256 }, (_, value) => srgbToLinear(value / 255));
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Two-sided source ridges, not arbitrary image edges. A smooth ramp has
 * opposite-signed differences and contributes no ridge. Topology uses alpha
 * >= 0.5. Each connected search keeps its seed's fixed RGB reference, so small
 * neighboring color differences cannot chain through an unlimited gradient. */
export function indexSourceStrokes(image: RgbaImage, scale: number): SourceStrokeIndex {
  const size = image.width * image.height, labels = new Int32Array(size).fill(-1);
  const strength = new Float32Array(size), direction = new Uint8Array(size), directionMask = new Uint8Array(size), radiusAt = new Uint8Array(size), polarity = new Int8Array(size), luminance = new Float32Array(size);
  const radii = [...new Set([Math.max(1, Math.min(6, Math.round(.12 / scale))), Math.max(1, Math.min(8, Math.round(.24 / scale)))])];
  for (let i = 0; i < size; i++) luminance[i] = (.2126 * image.data[i * 4] + .7152 * image.data[i * 4 + 1] + .0722 * image.data[i * 4 + 2]) / 255;
  const seeds: number[] = [];
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const index = y * image.width + x;
    if (image.data[index * 4 + 3] < 128) continue;
    const center = luminance[index]; let best = 0, bestDirection = 0, bestRadius = 0, sign = 0;
    const directional = [0, 0, 0, 0];
    for (const radius of radii) for (let orientation = 0; orientation < NORMALS.length; orientation++) {
      const [nx, ny] = NORMALS[orientation], ax = x - nx * radius, ay = y - ny * radius, bx = x + nx * radius, by = y + ny * radius;
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= image.width || bx >= image.width || ay >= image.height || by >= image.height) continue;
      const a = ay * image.width + ax, b = by * image.width + bx;
      if (image.data[a * 4 + 3] < 128 || image.data[b * 4 + 3] < 128) continue;
      const dark = Math.min(luminance[a] - center, luminance[b] - center), light = Math.min(center - luminance[a], center - luminance[b]);
      const contrast = Math.max(dark, light), imbalance = Math.abs(luminance[a] - luminance[b]);
      if (contrast < .055 || imbalance > Math.max(.025, contrast * .8)) continue;
      const value = contrast - .35 * imbalance;
      directional[orientation] = Math.max(directional[orientation], value);
      if (value > best) { best = value; bestDirection = orientation; bestRadius = radius; sign = dark > light ? -1 : 1; }
    }
    if (best > 0) {
      strength[index] = best; direction[index] = bestDirection; radiusAt[index] = bestRadius; polarity[index] = sign;
      for (let i = 0; i < directional.length; i++) if (directional[i] >= best * .9) directionMask[index] |= 1 << i;
      seeds.push(index);
    }
  }
  seeds.sort((a, b) => strength[b] - strength[a] || a - b);
  const queue = new Uint32Array(size), distance = new Int32Array(size), seen = new Uint32Array(size);
  let stamp = 0;
  const strokes: SourceStroke[] = [];
  const rgbDistance = (a: number, b: number) => Math.hypot(image.data[a * 4] - image.data[b * 4], image.data[a * 4 + 1] - image.data[b * 4 + 1], image.data[a * 4 + 2] - image.data[b * 4 + 2]) / (255 * Math.sqrt(3));
  const neighbors = (index: number, visit: (next: number, dx: number, dy: number) => void) => {
    const x = index % image.width, y = Math.floor(index / image.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || y + dy < 0 || x + dx >= image.width || y + dy >= image.height) continue;
      visit((y + dy) * image.width + x + dx, dx, dy);
    }
  };
  function farthest(start: number, id: number): { pixel: number; distance: number } {
    stamp++; let head = 0, tail = 1, winner = start;
    queue[0] = start; seen[start] = stamp; distance[start] = 0;
    while (head < tail) {
      const at = queue[head++];
      if (distance[at] > distance[winner] || distance[at] === distance[winner] && at < winner) winner = at;
      neighbors(at, next => { if (labels[next] === id && seen[next] !== stamp) { seen[next] = stamp; distance[next] = distance[at] + 1; queue[tail++] = next; } });
    }
    return { pixel: winner, distance: distance[winner] };
  }
  function endpointNeighborhood(start: number, id: number, steps: number): number[] {
    stamp++; let head = 0, tail = 1;
    queue[0] = start; seen[start] = stamp; distance[start] = 0;
    while (head < tail) {
      const at = queue[head++];
      if (distance[at] >= steps) continue;
      neighbors(at, next => {
        if (labels[next] !== id || seen[next] === stamp) return;
        seen[next] = stamp; distance[next] = distance[at] + 1; queue[tail++] = next;
      });
    }
    return Array.from(queue.subarray(0, tail));
  }
  function hasContrastingHole(id: number, left: number, top: number, right: number, bottom: number, own: Oklab): boolean {
    const width = right - left + 2, height = bottom - top + 2;
    const occupied = new Uint8Array(width * height), outside = new Uint8Array(width * height), flood = new Uint32Array(width * height);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (labels[y * image.width + x] === id) occupied[(y - top + 1) * width + x - left + 1] = 1;
    let head = 0, tail = 1; flood[0] = 0; outside[0] = 1;
    while (head < tail) {
      const at = flood[head++], x = at % width, y = Math.floor(at / width);
      for (const next of [x > 0 ? at - 1 : -1, x + 1 < width ? at + 1 : -1, y > 0 ? at - width : -1, y + 1 < height ? at + width : -1]) if (next >= 0 && !occupied[next] && !outside[next]) { outside[next] = 1; flood[tail++] = next; }
    }
    let count = 0, r = 0, g = 0, b = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const local = (y - top + 1) * width + x - left + 1;
      if (occupied[local] || outside[local]) continue;
      const at = (y * image.width + x) * 4;
      if (image.data[at + 3] < 128) return false;
      count++; r += LINEAR[image.data[at]]; g += LINEAR[image.data[at + 1]]; b += LINEAR[image.data[at + 2]];
    }
    if (count < Math.max(4, .04 / (scale * scale))) return false;
    const inside = linearToOklab({ r: r / count, g: g / count, b: b / count });
    return Math.hypot(inside.L - own.L, inside.a - own.a, inside.b - own.b) >= .08;
  }
  for (const seed of seeds) {
    if (labels[seed] !== -1) continue;
    const id = strokes.length, pixels: number[] = [];
    let head = 0, tail = 1, left = image.width, top = image.height, right = 0, bottom = 0, area = 0, contrast = 0, r = 0, g = 0, b = 0, br = 0, bg = 0, bb = 0, normalX = 0, normalY = 0;
    queue[0] = seed; labels[seed] = id;
    while (head < tail) {
      const at = queue[head++], x = at % image.width, y = Math.floor(at / image.width), alpha = image.data[at * 4 + 3] / 255;
      pixels.push(at); area += alpha; contrast += strength[at] * alpha;
      r += LINEAR[image.data[at * 4]] * alpha; g += LINEAR[image.data[at * 4 + 1]] * alpha; b += LINEAR[image.data[at * 4 + 2]] * alpha;
      const [normalDx, normalDy] = NORMALS[direction[at]], offset = (normalDy * image.width + normalDx) * radiusAt[at];
      for (const next of [at - offset, at + offset]) { br += LINEAR[image.data[next * 4]] * alpha; bg += LINEAR[image.data[next * 4 + 1]] * alpha; bb += LINEAR[image.data[next * 4 + 2]] * alpha; }
      let axes = 0, axisX = 0, axisY = 0;
      for (let orientation = 0; orientation < NORMALS.length; orientation++) if (directionMask[at] & (1 << orientation)) { axes++; axisX += Math.cos(orientation * Math.PI / 2); axisY += Math.sin(orientation * Math.PI / 2); }
      normalX += axisX / axes; normalY += axisY / axes;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      neighbors(at, (next, dx, dy) => {
        if (labels[next] !== -1 || strength[next] <= 0 || polarity[next] !== polarity[seed]) return;
        if (rgbDistance(seed, next) > .24 || rgbDistance(at, next) > .14) return;
        let compatible = false;
        for (let a = 0; a < NORMALS.length && !compatible; a++) if (directionMask[at] & (1 << a)) for (let b = 0; b < NORMALS.length; b++) if (directionMask[next] & (1 << b)) {
          const difference = Math.abs(a - b);
          if (Math.min(difference, 4 - difference) > 1) continue;
          const [nx, ny] = NORMALS[a], [mx, my] = NORMALS[b];
          const alignment = (Math.abs(-ny * dx + nx * dy) / Math.hypot(nx, ny) + Math.abs(-my * dx + mx * dy) / Math.hypot(mx, my)) / (2 * Math.hypot(dx, dy));
          if (alignment >= .25) { compatible = true; break; }
        }
        if (!compatible) return;
        labels[next] = id; queue[tail++] = next;
      });
    }
    const span = Math.max(right - left, bottom - top) * scale;
    const reject = () => { for (const pixel of pixels) labels[pixel] = -2; };
    if (pixels.length < 6 || span < 1 || span > 16 || pixels.length > 32768) { reject(); continue; }
    const a = farthest(seed, id), z = farthest(a.pixel, id), pathLength = z.distance + 1;
    const thickness = area * scale / pathLength;
    if (thickness > .6 || pathLength * scale < 1) { reject(); continue; }
    const color = linearToOklab({ r: r / area, g: g / area, b: b / area });
    const closed = hasContrastingHole(id, left, top, right, bottom, color);
    const coherence = Math.hypot(normalX, normalY) / pixels.length;
    // Antialiased arcs can have equally valid normal directions whose global
    // vectors cancel. A long thin ridge still has source geometry evidence:
    // every connection already passed the local tangent/color tests above.
    const elongated = Math.max(right - left, bottom - top) >= 3 * Math.min(right - left, bottom - top);
    if (!closed && coherence < .2 && !elongated) { reject(); continue; }
    const support = clamp(contrast / area / .15) * Math.min(1, span / 2);
    if (support <= .5) { reject(); continue; }
    const backdrop = linearToOklab({ r: br / (2 * area), g: bg / (2 * area), b: bb / (2 * area) });
    const sourceContrast = clamp(Math.hypot(color.L - backdrop.L, color.a - backdrop.a, color.b - backdrop.b));
    // Every 8-neighbor graph step is at most sqrt(2) source pixels. The quarter
    // diameter bound keeps the two end neighborhoods separate on short marks.
    const endpointSteps = Math.min(Math.floor(.5 / (Math.SQRT2 * scale)), Math.floor(z.distance / 4));
    const endpointNeighborhoods: [number[], number[]] = closed ? [[], []]
      : [endpointNeighborhood(a.pixel, id, endpointSteps), endpointNeighborhood(z.pixel, id, endpointSteps)];
    strokes.push({ pixels, left, top, right, bottom, area, color, contrast: sourceContrast, support, span, thickness, endpoints: [a.pixel, z.pixel], endpointNeighborhoods, closed });
  }
  // Similar short ridges form a texture family even when its endpoint pieces
  // straddle a size-bin boundary. Bins only accelerate a continuous comparison;
  // they do not decide whether two original pieces have comparable geometry.
  // Keep three witnesses per bin and stop after three matches: exp(-1) already
  // makes even maximum support insufficient. This bounds work on large images.
  const buckets = new Map<string, SourceStroke[]>();
  const coordinates = (stroke: SourceStroke) => [Math.floor(stroke.color.L * 25), Math.floor(stroke.color.a * 25), Math.floor(stroke.color.b * 25), Math.floor(Math.log2(stroke.area * scale * scale)), Math.floor(Math.log2(stroke.span))];
  for (const stroke of strokes) {
    const key = coordinates(stroke).join(':'), witnesses = buckets.get(key) ?? [];
    if (witnesses.length < 3) witnesses.push(stroke);
    buckets.set(key, witnesses);
  }
  for (const stroke of strokes) {
    const [l, a, b, area, span] = coordinates(stroke);
    const own = buckets.get([l, a, b, area, span].join(':'))!;
    // Every pair in one bin is within the continuous color/size limits.
    let repetitions = own.length;
    search: for (let da = -2; da <= 2 && repetitions < 3; da++) for (let ds = -1; ds <= 1; ds++) {
      for (let dl = -2; dl <= 2; dl++) for (let dc = -2; dc <= 2; dc++) for (let db = -2; db <= 2; db++) {
        if (!da && !ds && !dl && !dc && !db) continue;
        for (const other of buckets.get([l + dl, a + dc, b + db, area + da, span + ds].join(':')) ?? []) {
          if (Math.hypot(stroke.color.L - other.color.L, stroke.color.a - other.color.a, stroke.color.b - other.color.b) >= .08
            || Math.max(stroke.area / other.area, other.area / stroke.area) > 4
            || Math.max(stroke.span / other.span, other.span / stroke.span) > 2) continue;
          if (++repetitions >= 3) break search;
        }
      }
    }
    stroke.support *= Math.exp(-Math.max(0, repetitions - 2));
  }
  return { labels, strokes };
}

import type { RgbaImage } from '../contracts';
import { linearToOklab, srgbToLinear } from './color';
import { indexSourceStrokes, type SourceStrokeIndex } from './source-lines';

const LINEAR = Float64Array.from({ length: 256 }, (_, value) => srgbToLinear(value / 255));

export interface SourceComponent {
  key: number;
  pixels: number;
  area: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  boundarySupport: number;
  compactSupport: number;
  regionSupport: number;
  surroundContrast: number;
}
export interface SourceComponentIndex {
  width: number;
  scale: number;
  labels: Int32Array;
  components: SourceComponent[];
  strokes?: SourceStrokeIndex;
}

/** Source-space components are independent of target-grid phase. They extend
 * local footprint evidence through a cell boundary and recognize sufficiently
 * large compact marks; repeated similarly sized marks receive less confidence.
 * No target assignment, palette choice, user annotation or semantic label is
 * used. One/two-pixel specks never gain confidence just by being isolated. */
export function indexSourceComponents(image: RgbaImage, scale: number, crossBinStrokes = true): SourceComponentIndex {
  const size = image.width * image.height, labels = new Int32Array(size).fill(-1), keys = new Int16Array(size).fill(-1);
  const queue = new Uint32Array(size), components: SourceComponent[] = [];
  const means: { r: number; g: number; b: number }[] = [];
  // Area/color remain alpha weighted elsewhere. Connectivity requires visible
  // support so almost-transparent pixels cannot bridge unrelated specks.
  for (let i = 0; i < size; i++) if (image.data[i * 4 + 3] >= 128) {
    keys[i] = (image.data[i * 4] >> 4) * 256 + (image.data[i * 4 + 1] >> 4) * 16 + (image.data[i * 4 + 2] >> 4);
  }
  for (let start = 0; start < size; start++) {
    if (keys[start] < 0 || labels[start] !== -1) continue;
    const key = keys[start], id = components.length;
    let head = 0, tail = 1, area = 0, red = 0, green = 0, blue = 0, left = image.width, top = image.height, right = 0, bottom = 0;
    queue[0] = start; labels[start] = id;
    while (head < tail) {
      const at = queue[head++], x = at % image.width, y = Math.floor(at / image.width);
      const alpha = image.data[at * 4 + 3] / 255;
      area += alpha; red += alpha * LINEAR[image.data[at * 4]]; green += alpha * LINEAR[image.data[at * 4 + 1]]; blue += alpha * LINEAR[image.data[at * 4 + 2]];
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= image.width || y + dy < 0 || y + dy >= image.height) continue;
        const next = (y + dy) * image.width + x + dx;
        if (labels[next] === -1 && keys[next] === key) { labels[next] = id; queue[tail++] = next; }
      }
    }
    if (tail < 3) { for (let i = 0; i < tail; i++) labels[queue[i]] = -2; continue; }
    const w = (right - left) * scale, h = (bottom - top) * scale, major = Math.max(w, h), minor = Math.min(w, h);
    const density = area / ((right - left) * (bottom - top));
    const enclosed = left > 0 && top > 0 && right < image.width && bottom < image.height;
    const boundarySupport = major >= 1 ? Math.min(1, major / 2) : 0;
    const compactSupport = enclosed && major >= .35 && major <= 1.5 && minor >= .25 && density >= .5
      ? Math.min(1, density * Math.min(1, area * scale * scale / .125)) : 0;
    // Enclosed filled regions are separate source color evidence. Their upper
    // bound is relative to the source frame, not a tiny-highlight grid size.
    // They never become thin/compact minority opportunities just by existing.
    const regionSupport = enclosed && tail >= 9 && density >= .5 && major / Math.max(minor, 1e-12) <= 3
      && area * scale * scale >= .125 && area <= size * .15
      && right - left <= image.width * .65 && bottom - top <= image.height * .65 ? density : 0;
    // Tiny source fragments still have local footprint evidence. They do not
    // need a global object or a potentially large surrounding-ring scan.
    if (!boundarySupport && !compactSupport && !regionSupport) { for (let i = 0; i < tail; i++) labels[queue[i]] = -2; continue; }
    means.push({ r: red / area, g: green / area, b: blue / area });
    components.push({ key, pixels: tail, area, left, top, right, bottom,
      surroundContrast: 0, boundarySupport, compactSupport, regionSupport });
  }
  // Group comparable compact/linear pieces in coarse source-size buckets.
  // A repeated connected texture is not equivalent to a single eye glint.
  const buckets = new Map<string, number>();
  const bucket = (component: SourceComponent) => {
    const w = component.right - component.left, h = component.bottom - component.top;
    return `${component.key}:${Math.floor(Math.log2(component.area * scale * scale))}:${Math.max(w, h) / Math.min(w, h) >= 3 ? 'line' : 'compact'}`;
  };
  for (const component of components) if (component.boundarySupport || component.compactSupport || component.regionSupport) {
    const key = bucket(component); buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  for (const [id, component] of components.entries()) {
    const repetitions = buckets.get(bucket(component)) ?? 1;
    const confidence = Math.exp(-Math.max(0, repetitions - 2));
    component.boundarySupport *= confidence; component.compactSupport *= confidence; component.regionSupport *= confidence;
    if (component.compactSupport <= .5 && component.regionSupport <= .5) continue;
    // A glint may contrast with an eye even when the larger target cell is
    // mostly a similarly bright body. Read the ORIGINAL local ring only for
    // supported compact components; transparent pixels invent no background.
    const { left, top, right, bottom } = component, margin = Math.max(1, Math.ceil(.15 / scale));
    let mass = 0, r = 0, g = 0, b = 0;
    const add = (x: number, y: number) => { const at = (y * image.width + x) * 4, alpha = image.data[at + 3] / 255;
      mass += alpha; r += alpha * LINEAR[image.data[at]]; g += alpha * LINEAR[image.data[at + 1]]; b += alpha * LINEAR[image.data[at + 2]]; };
    for (let y = Math.max(0, top - margin); y < Math.min(image.height, bottom + margin); y++) {
      if (y < top || y >= bottom) for (let x = Math.max(0, left - margin); x < Math.min(image.width, right + margin); x++) add(x, y);
      else {
        for (let x = Math.max(0, left - margin); x < left; x++) add(x, y);
        for (let x = right; x < Math.min(image.width, right + margin); x++) add(x, y);
      }
    }
    if (mass > 0) {
      const own = linearToOklab(means[id]);
      const ring = linearToOklab({ r: r / mass, g: g / mass, b: b / mass });
      component.surroundContrast = Math.min(1, Math.hypot(own.L - ring.L, own.a - ring.a, own.b - ring.b));
    }
  }
  return { width: image.width, scale, labels, components, ...(crossBinStrokes ? { strokes: indexSourceStrokes(image, scale) } : {}) };
}

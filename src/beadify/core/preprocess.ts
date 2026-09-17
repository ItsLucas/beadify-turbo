import type { PreprocessingOptions, RgbaImage } from '../contracts';

export type PreparedImageResult = {
  image: RgbaImage;
  /** Row-major affine matrix mapping original pixel boundaries to the cropped image. */
  sourceToPrepared: [number, number, number, number, number, number, number, number, number];
  crop: [number, number, number, number];
  removedPixelCount: number;
  /** Estimated from opaque crop-boundary pixels; null means insufficient evidence. */
  backgroundColor: [number, number, number] | null;
};

export const DEFAULT_BACKGROUND_TOLERANCE = 24;
const MAX_SOURCE_SIDE = 4096;
const MAX_SOURCE_PIXELS = 4_194_304;

function invalid(path: string, message: string): never { throw new RangeError(`${path}: ${message}`); }

/** Tighten only rectangular outer margins. Interior white pixels, connected
 * white backgrounds and alpha are never flood-filled or modified. */
export function detectWhiteBorder(image: RgbaImage, options: PreprocessingOptions = {}, tolerance = 0) {
  validateInputs(image, options);
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 32) invalid('border.tolerance', 'expected integer in [0, 32]');
  const crop: PreparedImageResult['crop'] = options.crop ? [...options.crop] : [0, 0, image.width, image.height];
  const [left, top, right, bottom] = crop;
  let l = right, t = bottom, r = left, b = top;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = y * image.width + x, offset = i * 4;
    const margin = options.mask?.[i] !== 1 && (image.data[offset + 3] === 0 || [0, 1, 2].every(c => image.data[offset + c] >= 255 - tolerance));
    if (margin) continue;
    l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x + 1); b = Math.max(b, y + 1);
  }
  if (l >= r || t >= b) return { crop, status: 'empty' as const, removedMargins: [0, 0, 0, 0], trimmedPixels: 0 };
  const result: PreparedImageResult['crop'] = [l, t, r, b];
  const trimmedPixels = (right - left) * (bottom - top) - (r - l) * (b - t);
  return { crop: result, status: trimmedPixels ? 'trimmed' as const : 'unchanged' as const,
    removedMargins: [l - left, t - top, right - r, bottom - b], trimmedPixels };
}

/** Also used directly by the browser preview, outside the generation request validator. */
function validateInputs(image: RgbaImage, options: PreprocessingOptions): void {
  if (!image || typeof image !== 'object') invalid('image', 'expected RGBA image');
  if (!Number.isSafeInteger(image.width) || image.width < 1 || image.width > MAX_SOURCE_SIDE ||
      !Number.isSafeInteger(image.height) || image.height < 1 || image.height > MAX_SOURCE_SIDE ||
      image.width * image.height > MAX_SOURCE_PIXELS) invalid('image', 'invalid or excessive source dimensions');
  if ((!Array.isArray(image.data) && !(image.data instanceof Uint8ClampedArray)) || image.data.length !== image.width * image.height * 4) {
    invalid('image.data', 'expected one RGBA byte tuple per source pixel');
  }
  if (Array.isArray(image.data)) for (const byte of image.data) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) invalid('image.data', 'expected integer bytes in [0, 255]');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype) {
    invalid('preprocessing', 'expected a plain object');
  }
  for (const key of Object.keys(options)) {
    if (!['crop', 'background', 'tolerance', 'mask', 'smoothing'].includes(key)) invalid(`preprocessing.${key}`, 'unsupported field');
  }
  if ('smoothing' in options && typeof options.smoothing !== 'boolean') invalid('preprocessing.smoothing', 'expected boolean');
  if (options.crop !== undefined) {
    const crop = options.crop;
    if (!Array.isArray(crop) || crop.length !== 4 || ![0, 1, 2, 3].every(index => Number.isSafeInteger(crop[index])) ||
        crop[0] < 0 || crop[1] < 0 || crop[2] > image.width || crop[3] > image.height ||
        crop[0] >= crop[2] || crop[1] >= crop[3]) {
      invalid('preprocessing.crop', 'expected nonempty integer pixel bounds [left, top, right, bottom) inside the source');
    }
  }
  if (options.background !== undefined && options.background !== 'keep' && options.background !== 'edge') invalid('preprocessing.background', 'expected keep or edge');
  if (options.tolerance !== undefined && (!Number.isInteger(options.tolerance) || options.tolerance < 0 || options.tolerance > 255)) {
    invalid('preprocessing.tolerance', 'expected maximum sRGB channel difference in [0, 255]');
  }
  if (options.mask !== undefined) {
    if (!Array.isArray(options.mask) || options.mask.length !== image.width * image.height) {
      invalid('preprocessing.mask', 'expected one value per source pixel: 0 automatic, 1 keep, 2 remove');
    }
    for (const value of options.mask) if (value !== 0 && value !== 1 && value !== 2) invalid('preprocessing.mask', 'expected 0 automatic, 1 keep, or 2 remove');
  }
}

function perimeter(width: number, height: number): number[] {
  const pixels: number[] = [];
  for (let x = 0; x < width; x++) pixels.push(x);
  for (let y = 1; y < height; y++) pixels.push(y * width + width - 1);
  if (height > 1) for (let x = width - 2; x >= 0; x--) pixels.push((height - 1) * width + x);
  if (width > 1) for (let y = height - 2; y > 0; y--) pixels.push(y * width);
  return pixels;
}

/** A modal 16-level RGB bin is less affected by ears/objects at the border than its mean. */
function estimateBackground(data: Uint8ClampedArray, boundary: number[], mask: Uint8Array): [number, number, number] | null {
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (const pixel of boundary) {
    const offset = pixel * 4;
    if (data[offset + 3] < 128 || mask[pixel] !== 0) continue;
    opaque++;
    const r = data[offset], g = data[offset + 1], b = data[offset + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count++; bin.r += r; bin.g += g; bin.b += b;
    bins.set(key, bin);
  }
  // Existing alpha is stronger evidence than a handful of opaque ear/tail pixels.
  if (opaque < boundary.length / 2) return null;
  let dominant: { count: number; r: number; g: number; b: number } | undefined;
  for (const bin of bins.values()) if (!dominant || bin.count > dominant.count) dominant = bin;
  // A highly varied edge gives no reliable single-color background hypothesis.
  if (!dominant || dominant.count < opaque / 4) return null;
  return [Math.round(dominant.r / dominant.count), Math.round(dominant.g / dominant.count), Math.round(dominant.b / dominant.count)];
}

/**
 * Crop and remove only background connected to the crop boundary (4-neighbor).
 * Mask coordinates always refer to the original source. Keep marks block the fill;
 * both keep and automatic preserve original alpha, including partial coverage.
 * This function never mutates, resizes, or composites the original image.
 */
export function prepareImage(image: RgbaImage, options: PreprocessingOptions = {}): PreparedImageResult {
  validateInputs(image, options);
  const crop: PreparedImageResult['crop'] = options.crop ? [...options.crop] : [0, 0, image.width, image.height];
  const [left, top, right, bottom] = crop;
  const width = right - left, height = bottom - top, size = width * height;
  const data = new Uint8ClampedArray(size * 4), mask = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    const sourceOffset = ((y + top) * image.width + left) * 4;
    const row = image.data instanceof Uint8ClampedArray ? image.data.subarray(sourceOffset, sourceOffset + width * 4) : image.data.slice(sourceOffset, sourceOffset + width * 4);
    data.set(row, y * width * 4);
    if (options.mask) for (let x = 0; x < width; x++) mask[y * width + x] = options.mask[(y + top) * image.width + left + x];
  }
  let backgroundColor: PreparedImageResult['backgroundColor'] = null;
  const removed = new Uint8Array(size);
  if (options.background === 'edge') {
    const boundary = perimeter(width, height);
    backgroundColor = estimateBackground(data, boundary, mask);
    if (backgroundColor) {
      const tolerance = options.tolerance ?? DEFAULT_BACKGROUND_TOLERANCE;
      const queue = new Uint32Array(size);
      let head = 0, tail = 0;
      const enqueue = (pixel: number) => {
        if (removed[pixel] || mask[pixel] === 1) return;
        const offset = pixel * 4;
        if (data[offset + 3] !== 0 && Math.max(Math.abs(data[offset] - backgroundColor![0]),
          Math.abs(data[offset + 1] - backgroundColor![1]), Math.abs(data[offset + 2] - backgroundColor![2])) > tolerance) return;
        removed[pixel] = 1; queue[tail++] = pixel;
      };
      for (const pixel of boundary) enqueue(pixel);
      while (head < tail) {
        const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
        if (x > 0) enqueue(pixel - 1);
        if (x + 1 < width) enqueue(pixel + 1);
        if (y > 0) enqueue(pixel - width);
        if (y + 1 < height) enqueue(pixel + width);
      }
    }
  }
  let removedPixelCount = 0;
  for (let pixel = 0; pixel < size; pixel++) {
    if (mask[pixel] === 2 || removed[pixel]) {
      if (data[pixel * 4 + 3] !== 0) removedPixelCount++;
      data[pixel * 4 + 3] = 0;
    }
  }
  return {
    image: { width, height, data }, crop, removedPixelCount, backgroundColor,
    sourceToPrepared: [1, 0, left === 0 ? 0 : -left, 0, 1, top === 0 ? 0 : -top, 0, 0, 1],
  };
}

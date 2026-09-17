import type { ColorId, PaletteColor, Srgb8 } from '../contracts';

/** Distinct objects deliberately prevent passing OKLab values to CIEDE2000. */
export interface LinearRgb { r: number; g: number; b: number }
export interface Oklab { space: 'oklab'; L: number; a: number; b: number }
export interface CieLab { space: 'cie-lab-d65'; L: number; a: number; b: number }

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

export function srgb8ToLinear(rgb: Srgb8): LinearRgb {
  return { r: srgbToLinear(rgb[0] / 255), g: srgbToLinear(rgb[1] / 255), b: srgbToLinear(rgb[2] / 255) };
}

export function linearToSrgb8(rgb: LinearRgb): Srgb8 {
  const encode = (v: number) => Math.round(Math.max(0, Math.min(1, linearToSrgb(v))) * 255);
  return [encode(rgb.r), encode(rgb.g), encode(rgb.b)];
}

// Björn Ottosson's published 2021 matrices: https://bottosson.github.io/posts/oklab/
// Independently implemented from the mathematical definition; no upstream package is bundled.
export function linearToOklab({ r, g, b }: LinearRgb): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    space: 'oklab',
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToLinear({ L, a, b }: Oklab): LinearRgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

export function oklabDistance(first: Oklab, second: Oklab): number {
  if (first.space !== 'oklab' || second.space !== 'oklab') throw new Error('Expected OKLab colors');
  return Math.hypot(first.L - second.L, first.a - second.a, first.b - second.b);
}

/** CIE Lab with sRGB's D65 2° reference white; never OKLab. */
export function linearToCieLab({ r, g, b }: LinearRgb): CieLab {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (v: number) => v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116;
  return { space: 'cie-lab-d65', L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/** CIEDE2000, kL=kC=kH=1. See Sharma et al., https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/ */
export function deltaE00(first: CieLab, second: CieLab): number {
  if (first.space !== 'cie-lab-d65' || second.space !== 'cie-lab-d65') throw new Error('Expected CIE Lab D65 colors');
  const rad = Math.PI / 180;
  const c1 = Math.hypot(first.a, first.b), c2 = Math.hypot(second.a, second.b);
  const cMean7 = ((c1 + c2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(cMean7 / (cMean7 + 25 ** 7)));
  const a1 = (1 + G) * first.a, a2 = (1 + G) * second.a;
  const cp1 = Math.hypot(a1, first.b), cp2 = Math.hypot(a2, second.b);
  const hue = (a: number, b: number) => (Math.atan2(b, a) / rad + 360) % 360;
  const h1 = cp1 === 0 ? 0 : hue(a1, first.b), h2 = cp2 === 0 ? 0 : hue(a2, second.b);
  const dL = second.L - first.L, dC = cp2 - cp1;
  let dh = h2 - h1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * rad / 2);
  const Lm = (first.L + second.L) / 2, Cm = (cp1 + cp2) / 2;
  let hm = h1 + h2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) hm /= 2;
    else hm = (hm + (hm < 360 ? 360 : -360)) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad)
    + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const Sl = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cm, Sh = 1 + 0.015 * Cm * T;
  const Rt = -2 * Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7))
    * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt(Math.max(0, (dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh)));
}

export const compareColorIds = (a: ColorId, b: ColorId): number => a < b ? -1 : a > b ? 1 : 0;
export interface PreparedColor { id: ColorId; oklab: Oklab }
export interface ColorCandidate { colorId: ColorId; distance: number }

export function prepareColors(colors: readonly PaletteColor[]): PreparedColor[] {
  return colors.map(color => ({ id: color.id, oklab: linearToOklab(srgb8ToLinear(color.srgb8)) }));
}

export function topKColors(target: Oklab, colors: readonly PreparedColor[], k = 5): ColorCandidate[] {
  if (!Number.isInteger(k) || k < 1 || k > 512) throw new Error('k must be an integer in [1, 512]');
  return colors.map(color => ({ colorId: color.id, distance: oklabDistance(target, color.oklab) }))
    .sort((a, b) => a.distance - b.distance || compareColorIds(a.colorId, b.colorId)).slice(0, k);
}

/** Avoid allocating and sorting a full candidate array per baseline cell. */
export function nearestColor(target: Oklab, colors: readonly PreparedColor[]): ColorId {
  let winner: ColorId | undefined, best = Infinity;
  for (const color of colors) {
    const distance = (target.L - color.oklab.L) ** 2 + (target.a - color.oklab.a) ** 2 + (target.b - color.oklab.b) ** 2;
    if (distance < best || (distance === best && (winner === undefined || compareColorIds(color.id, winner) < 0))) {
      best = distance;
      winner = color.id;
    }
  }
  if (winner === undefined) throw new Error('No candidate colors');
  return winner;
}

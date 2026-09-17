import type { RgbaImage } from './beadify/contracts';
import { compareColorIds, linearToOklab, oklabDistance, srgb8ToLinear } from './beadify/core/color';
import type { PaletteColor } from './types';

export type SourceColorSample = { x: number; y: number; rgb: [number, number, number]; alpha: number };

export function sampleSourceColor(image: RgbaImage, x: number, y: number): SourceColorSample | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  x = Math.floor(x); y = Math.floor(y);
  const offset = (y * image.width + x) * 4;
  const alpha = image.data[offset + 3];
  if (!alpha) return null;
  // Match the white background used by the picker preview, never hidden RGB in transparent pixels.
  const rgb = [0, 1, 2].map(channel => Math.round((image.data[offset + channel] * alpha + 255 * (255 - alpha)) / 255)) as [number, number, number];
  return { x, y, rgb, alpha };
}

export function similarSourceColors(rgb: [number, number, number], palette: readonly PaletteColor[]): PaletteColor[] {
  const target = linearToOklab(srgb8ToLinear(rgb));
  return palette.map(color => ({ color, distance: oklabDistance(target, linearToOklab(srgb8ToLinear(color.rgb))) }))
    .sort((a, b) => a.distance - b.distance || compareColorIds(a.color.id, b.color.id))
    .slice(0, 6).map(candidate => candidate.color);
}

export function sourceColorHex(rgb: [number, number, number]): string {
  return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

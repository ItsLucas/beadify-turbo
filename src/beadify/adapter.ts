import { imageDimensions, validateImageDimensions } from './image-header';
import type { PaletteColor as WorkspaceColor, ConvertResult } from '../types';
import type { BeadPattern, Palette } from './contracts/index';
import { loadPalette } from './core/index';
import { paletteVersion } from '../palette';
import { workspaceId } from './workspace-generation';

export function workspacePalette(colors: WorkspaceColor[]): Palette {
  return loadPalette({
    id: 'MARD:upstream-approximate', version: paletteVersion,
    source: 'https://github.com/Jett-Wu/Perler_Beads_Generator/blob/36ac52d570246ab600611a79edd2236bccb954e5/src/palette.ts',
    license: 'Upstream code MIT; original color-data permission unverified', approximate: true,
    colors: colors.map((color) => ({ id: `MARD:unspecified:${color.primaryCode}`, brand: 'MARD', series: 'unspecified', code: color.primaryCode, srgb8: [...color.rgb], name: color.name })),
  });
}

export function workspaceResult(pattern: BeadPattern): ConvertResult {
  const mapping = new Map(pattern.paletteSnapshot.colors.map((color) => [color.id, workspaceId(pattern.paletteSnapshot, color.id)]));
  return {
    width: pattern.width, height: pattern.height,
    cells: pattern.cells.map((cell) => cell === null ? null : mapping.get(cell)!),
    colorsUsed: pattern.diagnostics.usedColors,
    totalBeads: pattern.cells.filter((cell) => cell !== null).length,
  };
}

export async function decodeImage(file: File): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  if (file.size > 20 * 1024 * 1024) throw new Error('图片不得超过 20 MiB / Image exceeds 20 MiB');
  validateImageDimensions(imageDimensions(new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer())));
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 4_194_304) {
      throw new Error('图片最多 4 百万像素，单边最多 4096 / Resize the image before importing');
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally { bitmap.close(); }
}

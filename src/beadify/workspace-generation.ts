import type { BeadProject } from '../types';
import type { CellConstraint, Palette, RgbaImage, GenerationRequest } from './contracts/index';
import { projectColor } from '../project';
import { resizeSourceRaster } from './core/source-raster';
export { resizeSourceRaster } from './core/source-raster';

export function workspaceId(palette: Palette, id: string): string {
  const color = palette.colors.find(color => color.id === id);
  if (!color) throw new Error(`Unknown color ${id}`);
  return color.brand === 'MARD' ? `mard-${color.code.toLowerCase()}` : color.id;
}

export function parseColorCodes(value: string, palette: Palette): string[] {
  const result = value.trim().split(/[\s,，]+/).filter(Boolean).map(value => {
    const color = palette.colors.find(color => color.id === value || color.code.toUpperCase() === value.toUpperCase());
    if (!color) throw new Error(`色卡中没有色号 ${value}`);
    return color.id;
  });
  return [...new Set(result)];
}

export function currentRaster(project: BeadProject): RgbaImage {
  const data = new Uint8ClampedArray(project.width * project.height * 4);
  project.cells.forEach((id, index) => {
    if (id === null) return;
    const color = projectColor(project, id);
    if (!color) throw new Error(`Unknown project color ${id}`);
    data.set([...color.rgb, 255], index * 4);
  });
  return { width: project.width, height: project.height, data };
}

export function roiConstraints(project: BeadProject, palette: Palette, indices: number[]): CellConstraint[] {
  const selected = new Set(indices);
  const toCore = new Map(palette.colors.map(color => [workspaceId(palette, color.id), color.id]));
  const outside = new Map<string | null, number[]>();
  project.cells.forEach((id, index) => {
    if (selected.has(index)) return;
    const group = outside.get(id) ?? []; group.push(index); outside.set(id, group);
  });
  const constraints: CellConstraint[] = (project.beadify?.constraints ?? []).map(constraint => ({ ...constraint, cellIndices: constraint.kind === 'feature' ? [...constraint.cellIndices] : constraint.cellIndices.filter(i => selected.has(i)) })).filter(c => c.cellIndices.length);
  for (const [id, cellIndices] of outside) {
    if (id === null) constraints.push({ kind: 'lock-empty', cellIndices });
    else {
      const colorId = toCore.get(id);
      if (!colorId) throw new Error(`Locked color ${id} is not in the selected palette`);
      constraints.push({ kind: 'lock-color', colorId, cellIndices });
    }
  }
  return constraints;
}

/** Reuse the original source evidence while freezing every exterior edited cell. */
export function sourceRoiRequest(project: BeadProject, palette: Palette, indices: number[], config: Pick<GenerationRequest, 'maxColors' | 'style' | 'allowedColors' | 'requiredColors' | 'optimization'>): GenerationRequest {
  const cached = project.beadify?.sourceRaster;
  if (!cached) throw new Error('No cached source evidence; use current-pattern cleanup or select the original image again.');
  const preparedRaster = resizeSourceRaster(cached, project.width, project.height);
  return { schemaVersion: 1, revision: 0, width: project.width, height: project.height, image: currentRaster(project), palette,
    method: 'optimized', ...config, preparedRaster, constraints: roiConstraints(project, palette, indices) };
}

/** The unchanged upstream API accepts Files; fit to the same target aspect before encoding. */
export async function originalInputFile(image: RgbaImage, width: number, height: number): Promise<File> {
  const source = document.createElement('canvas'); source.width = image.width; source.height = image.height;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('Canvas unavailable');
  sourceContext.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  const ratio = width / height;
  const paddedWidth = Math.max(image.width, image.height * ratio, width);
  const paddedHeight = paddedWidth / ratio;
  const shrink = Math.min(1, 2048 / Math.max(paddedWidth, paddedHeight), Math.sqrt(4_194_304 / (paddedWidth * paddedHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(width, Math.round(paddedWidth * shrink));
  canvas.height = Math.max(height, Math.round(canvas.width / ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
  context.drawImage(source, (canvas.width - image.width * scale) / 2, (canvas.height - image.height * scale) / 2, image.width * scale, image.height * scale);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode image'))));
  return new File([blob], 'prepared.png', { type: 'image/png' });
}

export function remapConstraints(constraints: CellConstraint[], oldWidth: number, newWidth: number, newHeight: number): CellConstraint[] {
  return constraints.map(constraint => ({ ...constraint, cellIndices: constraint.cellIndices.filter(i => i % oldWidth < newWidth && Math.floor(i / oldWidth) < newHeight).map(i => Math.floor(i / oldWidth) * newWidth + i % oldWidth) })).filter(c => c.cellIndices.length);
}

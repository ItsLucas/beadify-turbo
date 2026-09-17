import type { CellConstraint, GenerationRequest, PatternGeometry, RgbaImage, SourceFeatureRegion, SourceRaster } from '../contracts';
import { hashJson, sha256 } from './hash';
import { prepareImage } from './preprocess';
import { sampleStructuredImage, smoothImage, type TargetRaster } from './sampling';
import { patternGeometry, validateRequest, validateSourceRaster } from './validation';

/** Project original-frame binary labels through crop/alpha/contain/phase.
 * Labels are never inferred from output colors and cannot resurrect removed pixels. */
export function projectSourceFeatures(features: SourceFeatureRegion[], preparedImage: RgbaImage, geometry: PatternGeometry, width: number, height: number, target: TargetRaster): { constraints: CellConstraint[]; warnings: string[] } {
  const constraints: CellConstraint[] = [], warnings: string[] = [];
  const [cropX, cropY] = geometry.crop ?? [0, 0], scale = geometry.sourceToGrid[0], dx = geometry.sourceToGrid[2], dy = geometry.sourceToGrid[5];
  for (const feature of features) {
    if (feature.importance * feature.confidence === 0) continue;
    const coverage = new Float64Array(width * height);
    for (const [start, length] of feature.mask.runs) for (let source = start; source < start + length; source++) {
      const sx = source % feature.mask.width, sy = Math.floor(source / feature.mask.width), px = sx - cropX, py = sy - cropY;
      if (px < 0 || py < 0 || px >= preparedImage.width || py >= preparedImage.height) continue;
      const alpha = preparedImage.data[(py * preparedImage.width + px) * 4 + 3] / 255;
      if (!alpha) continue;
      const x0 = sx * scale + dx, y0 = sy * scale + dy, x1 = x0 + scale, y1 = y0 + scale;
      for (let gy = Math.max(0, Math.floor(y0)); gy < Math.min(height, Math.ceil(y1)); gy++) for (let gx = Math.max(0, Math.floor(x0)); gx < Math.min(width, Math.ceil(x1)); gx++) {
        coverage[gy * width + gx] += alpha * Math.max(0, Math.min(gx + 1, x1) - Math.max(gx, x0)) * Math.max(0, Math.min(gy + 1, y1) - Math.max(gy, y0));
      }
    }
    const cellIndices: number[] = [];
    coverage.forEach((value, index) => { if (value + 1e-12 >= .04 && target[index] !== null) cellIndices.push(index); });
    if (!cellIndices.length) { warnings.push(`Feature ${feature.label}: no foreground cell has at least 4% source coverage; increase grid size or revise the source mark.`); continue; }
    if (cellIndices.length < feature.minCells) warnings.push(`Feature ${feature.label}: ${cellIndices.length} supported cells cannot satisfy minCells=${feature.minCells}.`);
    constraints.push({ kind: 'feature', cellIndices, colorIds: [...feature.colorIds], minCells: feature.minCells,
      strength: feature.importance * feature.confidence, allowSingleton: feature.allowSingleton });
  }
  return { constraints, warnings };
}

/** Palette-independent source evidence, reusable after the original file is closed. */
export function createSourceRaster(request: GenerationRequest, sourceHash = sha256(request.image.data)): SourceRaster {
  validateRequest(request);
  if (request.preparedRaster) throw new Error('Cannot resample an already prepared raster');
  const prepared = request.preprocessing ? prepareImage(request.image, request.preprocessing).image : request.image;
  const image = request.preprocessing?.smoothing && request.style !== 'pixel-input' ? smoothImage(prepared) : prepared;
  const geometry = patternGeometry(request.image.width, request.image.height, request.width, request.height, request.preprocessing?.crop, request.phase);
  const samplingGeometry = patternGeometry(image.width, image.height, request.width, request.height, undefined, request.phase);
  const cells = sampleStructuredImage(image, request.width, request.height, samplingGeometry, request.style ?? 'clean', { ...request.sampling, sourceImage: prepared });
  const features = projectSourceFeatures(request.sourceFeatures ?? [], prepared, geometry, request.width, request.height, cells);
  const content = { schemaVersion: 1 as const, algorithmVersion: 5, width: request.width, height: request.height, frameWidth: request.width, frameHeight: request.height,
    sourceHash, inputHash: hashJson({ engine: 'beadify-source-v5', rgba: sha256(request.image.data), width: request.image.width, height: request.image.height,
      preprocessing: request.preprocessing ?? null, geometry, style: request.style ?? 'clean', sampling: request.sampling ?? {}, sourceFeatures: request.sourceFeatures ?? [] }),
    geometry, cells, sampling: { ...request.sampling }, features: features.constraints, warnings: features.warnings.slice(0, 128) };
  const raster: SourceRaster = { ...content, configHash: hashJson(content) };
  validateSourceRaster(raster);
  return raster;
}

/** Top-left canvas resize preserves the source transform, including smaller source frames. */
export function resizeSourceRaster(raster: SourceRaster, width: number, height: number): SourceRaster {
  validateSourceRaster(raster);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 256 || height > 256) throw new Error('Invalid source raster canvas dimensions');
  if (width === raster.width && height === raster.height) return raster;
  const cells: SourceRaster['cells'] = Array(width * height).fill(null);
  for (let y = 0; y < Math.min(height, raster.height); y++) for (let x = 0; x < Math.min(width, raster.width); x++) cells[y * width + x] = raster.cells[y * raster.width + x];
  const features = raster.features.map(feature => ({ ...feature, cellIndices: feature.cellIndices.filter(i => i % raster.width < width && Math.floor(i / raster.width) < height).map(i => Math.floor(i / raster.width) * width + i % raster.width) })).filter(feature => feature.cellIndices.length);
  const { configHash: _hash, ...rest } = raster;
  const content = { ...rest, width, height, cells, features, geometry: { ...raster.geometry, frameWidth: raster.frameWidth, frameHeight: raster.frameHeight } };
  return { ...content, configHash: hashJson(content) };
}

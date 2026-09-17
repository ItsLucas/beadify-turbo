import type { BeadPattern, GenerationRequest, Palette, PatternGeometry, SourceRaster, SourceFeatureRegion, CellConstraint } from '../contracts';
import { compareColorIds } from './color';
import { hashJson } from './hash';
import { inspectCells, inspectConnectivity } from './grid';

export const LIMITS = Object.freeze({ sourceSide: 4096, sourcePixels: 4_194_304, targetSide: 256, paletteColors: 512 });

export class ValidationError extends Error {
  readonly code = 'INVALID_INPUT';
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ValidationError';
  }
}

function fail(path: string, message: string): never { throw new ValidationError(path, message); }
function object(value: unknown, path: string, keys: readonly string[], required = keys): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(path, 'expected a plain object');
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown or unsupported field');
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(result, key)) fail(`${path}.${key}`, 'missing required field');
  return result;
}
function integer(value: unknown, path: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(path, `expected integer in [${min}, ${max}]`);
}
function text(value: unknown, path: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) fail(path, `expected nonempty string of at most ${max} characters`);
}
function array(value: unknown, path: string, min: number, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `expected array length in [${min}, ${max}]`);
}
function version(value: unknown, path: string) { if (value !== 1) fail(path, 'unsupported schema version; expected 1'); }

/** Validate and clone a palette. No fetching, file paths, brand claims or bundled manufacturer data. */
export function loadPalette(input: unknown): Palette {
  const palette = object(input, 'palette', ['id', 'version', 'source', 'license', 'approximate', 'colors']);
  for (const key of ['id', 'version']) text(palette[key], `palette.${key}`);
  for (const key of ['source', 'license']) text(palette[key], `palette.${key}`, 2048);
  if (typeof palette.approximate !== 'boolean') fail('palette.approximate', 'expected boolean');
  array(palette.colors, 'palette.colors', 1, LIMITS.paletteColors);
  const ids = new Set<string>(), codes = new Set<string>();
  const colors = palette.colors.map((entry, index) => {
    const path = `palette.colors[${index}]`;
    const color = object(entry, path, ['id', 'brand', 'series', 'code', 'name', 'srgb8'], ['id', 'brand', 'series', 'code', 'srgb8']);
    for (const key of ['id', 'brand', 'series', 'code']) text(color[key], `${path}.${key}`);
    if (Object.prototype.hasOwnProperty.call(color, 'name')) text(color.name, `${path}.name`);
    array(color.srgb8, `${path}.srgb8`, 3, 3);
    for (let i = 0; i < 3; i++) integer(color.srgb8[i], `${path}.srgb8[${i}]`, 0, 255);
    const id = color.id as string;
    const code = JSON.stringify([color.brand, color.series, color.code]);
    if (ids.has(id)) fail(`${path}.id`, 'duplicate ColorId');
    if (codes.has(code)) fail(`${path}.code`, 'duplicate brand/series/code');
    ids.add(id); codes.add(code);
    return { ...color, srgb8: [...color.srgb8] };
  });
  return { ...palette, colors } as Palette;
}

export function canonicalPalette(palette: Palette): Palette {
  return { ...palette, colors: [...palette.colors].sort((a, b) => compareColorIds(a.id, b.id)) as Palette['colors'] };
}

export function paletteHash(palette: Palette): string { return hashJson(canonicalPalette(palette)); }

export function validateRequest(input: unknown): asserts input is GenerationRequest {
  const request = object(input, 'request', ['schemaVersion', 'revision', 'image', 'width', 'height', 'palette', 'method', 'maxColors', 'allowedColors', 'requiredColors', 'constraints', 'preprocessing', 'style', 'phase', 'optimization', 'sampling', 'sourceFeatures', 'preparedRaster'], ['schemaVersion', 'revision', 'image', 'width', 'height', 'palette', 'method', 'maxColors']);
  version(request.schemaVersion, 'request.schemaVersion');
  integer(request.revision, 'request.revision', 0, Number.MAX_SAFE_INTEGER);
  integer(request.width, 'request.width', 1, LIMITS.targetSide);
  integer(request.height, 'request.height', 1, LIMITS.targetSide);
  integer(request.maxColors, 'request.maxColors', 1, LIMITS.paletteColors);
  if (!['nearest', 'area', 'dominant', 'optimized'].includes(request.method as string)) fail('request.method', 'unsupported sampling method');
  if (request.style !== undefined && !['accurate', 'clean', 'pixel-art', 'pixel-input'].includes(request.style as string)) fail('request.style', 'unsupported style');
  if (request.phase !== undefined) {
    array(request.phase, 'request.phase', 2, 2);
    request.phase.forEach(value => finite(value, 'request.phase[]', -0.49, 0.49));
  }
  const image = object(request.image, 'request.image', ['width', 'height', 'data']);
  integer(image.width, 'request.image.width', 1, LIMITS.sourceSide);
  integer(image.height, 'request.image.height', 1, LIMITS.sourceSide);
  const size = image.width * image.height;
  if (size > LIMITS.sourcePixels) fail('request.image', `source pixels exceed ${LIMITS.sourcePixels}`);
  if (!Array.isArray(image.data) && !(image.data instanceof Uint8ClampedArray)) fail('request.image.data', 'expected JSON byte array or Uint8ClampedArray');
  if (image.data.length !== size * 4) fail('request.image.data', `expected exactly ${size * 4} RGBA bytes`);
  // A Uint8ClampedArray already guarantees finite bytes. For JSON arrays, construct
  // the detailed path only on failure rather than allocating millions of strings.
  if (Array.isArray(image.data)) {
    for (let i = 0; i < image.data.length; i++) {
      const byte = image.data[i];
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) fail(`request.image.data[${i}]`, 'expected integer byte in [0, 255]');
    }
  }
  const palette = loadPalette(request.palette);
  const ids = new Set(palette.colors.map(color => color.id));
  if (Object.prototype.hasOwnProperty.call(request, 'allowedColors')) {
    array(request.allowedColors, 'request.allowedColors', 1, LIMITS.paletteColors);
    const ids = new Set(palette.colors.map(color => color.id)), allowed = new Set<string>();
    for (const id of request.allowedColors) {
      text(id, 'request.allowedColors[]');
      if (!ids.has(id)) fail('request.allowedColors', `unknown ColorId ${id}`);
      if (allowed.has(id)) fail('request.allowedColors', `duplicate ColorId ${id}`);
      allowed.add(id);
    }
  }
  if (request.requiredColors !== undefined) {
    array(request.requiredColors, 'request.requiredColors', 0, LIMITS.paletteColors);
    const seen = new Set<string>();
    for (const id of request.requiredColors) {
      text(id, 'request.requiredColors[]');
      if (!ids.has(id)) fail('request.requiredColors', `unknown ColorId ${id}`);
      if (seen.has(id)) fail('request.requiredColors', `duplicate ColorId ${id}`);
      seen.add(id);
    }
  }
  if (request.preprocessing !== undefined) {
    const options = object(request.preprocessing, 'request.preprocessing', ['crop', 'background', 'tolerance', 'mask', 'smoothing'], []);
    if (options.crop !== undefined) validateCrop(options.crop, image.width, image.height, 'request.preprocessing.crop');
    if (options.background !== undefined && options.background !== 'keep' && options.background !== 'edge') fail('request.preprocessing.background', 'expected keep or edge');
    if (options.tolerance !== undefined) integer(options.tolerance, 'request.preprocessing.tolerance', 0, 255);
    if (options.smoothing !== undefined && typeof options.smoothing !== 'boolean') fail('request.preprocessing.smoothing', 'expected boolean');
    if (options.mask !== undefined) {
      array(options.mask, 'request.preprocessing.mask', size, size);
      options.mask.forEach(value => integer(value, 'request.preprocessing.mask[]', 0, 2));
    }
  }
  if (request.constraints !== undefined) validateCellConstraints(request.constraints, request.width, request.height, ids);
  if (request.optimization !== undefined) validateOptimizationOptions(request.optimization);
  if (request.sampling !== undefined) validateSamplingOptions(request.sampling);
  if (request.sourceFeatures !== undefined) validateSourceFeatures(request.sourceFeatures, image.width, image.height, ids);
  if (request.preparedRaster !== undefined) {
    validateSourceRaster(request.preparedRaster);
    if (request.preparedRaster.width !== request.width || request.preparedRaster.height !== request.height) fail('request.preparedRaster', 'raster dimensions do not match request');
    if (request.preprocessing !== undefined || request.phase !== undefined || request.sampling !== undefined || request.sourceFeatures !== undefined) fail('request.preparedRaster', 'prepared evidence cannot be combined with resampling options');
    validateCellConstraints(request.preparedRaster.features, request.width, request.height, ids);
  }
  if (request.method !== 'optimized' && (request.constraints !== undefined || request.requiredColors !== undefined || request.optimization !== undefined || request.sourceFeatures !== undefined || request.preparedRaster !== undefined)) fail('request.method', 'constraints and optimization settings require optimized method');
  if (!['dominant', 'optimized'].includes(request.method as string) && request.sampling !== undefined) fail('request.sampling', 'sampling options require dominant or optimized method');

}

export function validateSamplingOptions(input: unknown): void {
  const options = object(input, 'sampling', ['strategy', 'sourceEdges', 'crossBinStrokes'], []);
  if (options.strategy !== undefined && !['dominant', 'mean', 'weighted-area', 'modes'].includes(options.strategy as string)) fail('sampling.strategy', 'unknown strategy');
  if (options.crossBinStrokes !== undefined && typeof options.crossBinStrokes !== 'boolean') fail('sampling.crossBinStrokes', 'expected boolean');
  if (options.sourceEdges !== undefined && typeof options.sourceEdges !== 'boolean') fail('sampling.sourceEdges', 'expected boolean');
}

export function validateOptimizationOptions(input: unknown): void {
  const options = object(input, 'optimization', ['iterations', 'maxEvaluations', 'symmetry', 'restarts', 'seed', 'weights', 'islandMaxSize', 'unary', 'sourceComponents', 'sourceShapes', 'sourceColors'], []);
  if (options.iterations !== undefined) integer(options.iterations, 'optimization.iterations', 0, 30);
  if (options.maxEvaluations !== undefined) integer(options.maxEvaluations, 'optimization.maxEvaluations', 1, 2_000_000);
  if (options.symmetry !== undefined && typeof options.symmetry !== 'boolean') fail('optimization.symmetry', 'expected boolean');
  if (options.restarts !== undefined) integer(options.restarts, 'optimization.restarts', 1, 8);
  if (options.seed !== undefined) integer(options.seed, 'optimization.seed', 0, 0xffffffff);
  if (options.islandMaxSize !== undefined) integer(options.islandMaxSize, 'optimization.islandMaxSize', 1, 16);
  for (const key of ['sourceShapes', 'sourceColors']) if (options[key] !== undefined && typeof options[key] !== 'boolean') fail(`optimization.${key}`, 'expected boolean');
  if (options.sourceComponents !== undefined && typeof options.sourceComponents !== 'boolean') fail('optimization.sourceComponents', 'expected boolean');
  if (options.unary !== undefined && !['representative', 'modes'].includes(options.unary as string)) fail('optimization.unary', 'unknown strategy');
  if (options.weights !== undefined) {
    const weights = object(options.weights, 'optimization.weights', ['color', 'smooth', 'edge', 'island', 'palette', 'feature', 'symmetry'], []);
    for (const [key, value] of Object.entries(weights)) finite(value, `optimization.weights.${key}`, 0, 10);
  }
}

export function validateCellConstraints(input: unknown, width: number, height: number, ids?: Set<string>): asserts input is CellConstraint[] {
  array(input, 'constraints', 0, 1024);
  let total = 0;
  for (const entry of input) {
    const c = object(entry, 'constraints[]', ['kind', 'cellIndices', 'colorId', 'colorIds', 'strength', 'minCells', 'allowSingleton'], ['kind', 'cellIndices']);
    if (!['lock-color', 'lock-empty', 'protect', 'simplify', 'feature'].includes(c.kind as string)) fail('constraints.kind', 'unknown kind');
    array(c.cellIndices, 'constraints.cellIndices', 1, width * height);
    total += c.cellIndices.length;
    if (total > 1_048_576) fail('constraints', 'too many referenced cells');
    const seen = new Set<number>();
    for (const index of c.cellIndices) { integer(index, 'constraints.cellIndices[]', 0, width * height - 1); if (seen.has(index)) fail('constraints.cellIndices', 'duplicate cell'); seen.add(index); }
    if (c.kind === 'lock-color' || (c.kind === 'feature' && c.colorIds === undefined)) {
      text(c.colorId, 'constraints.colorId');
    }
    if (c.colorId !== undefined) {
      text(c.colorId, 'constraints.colorId');
      if (ids && !ids.has(c.colorId)) fail('constraints.colorId', 'unknown ColorId');
      if (c.kind !== 'lock-color' && c.kind !== 'feature') fail('constraints.colorId', 'only lock-color and feature accept colorId');
    }
    if (c.colorIds !== undefined) {
      if (c.kind !== 'feature' || c.colorId !== undefined) fail('constraints.colorIds', 'feature accepts either colorId or colorIds');
      validateIds(c.colorIds, 'constraints.colorIds', ids);
    }
    if (c.strength !== undefined) { finite(c.strength, 'constraints.strength', 0, 10); if (String(c.kind).startsWith('lock')) fail('constraints.strength', 'hard locks have no strength'); }
    if (c.minCells !== undefined) { if (c.kind !== 'feature') fail('constraints.minCells', 'requires feature'); integer(c.minCells, 'constraints.minCells', 1, 65536); }
    if (c.allowSingleton !== undefined && (c.kind !== 'feature' || typeof c.allowSingleton !== 'boolean')) fail('constraints.allowSingleton', 'requires a feature boolean');
  }
}

function validateIds(input: unknown, path: string, ids?: Set<string>): void {
  array(input, path, 1, 512); const seen = new Set<string>();
  for (const id of input) { text(id, path); if (seen.has(id) || (ids && !ids.has(id))) fail(path, 'unknown or duplicate ColorId'); seen.add(id); }
}

export function validateSourceFeatures(input: unknown, width?: number, height?: number, ids?: Set<string>): asserts input is SourceFeatureRegion[] {
  array(input, 'sourceFeatures', 0, 128); const names = new Set<string>(); let totalRuns = 0;
  for (const entry of input) {
    const f = object(entry, 'sourceFeatures[]', ['id', 'label', 'mask', 'colorIds', 'minCells', 'importance', 'confidence', 'allowSingleton']);
    text(f.id, 'sourceFeatures.id', 128); text(f.label, 'sourceFeatures.label', 256);
    if (names.has(f.id)) fail('sourceFeatures.id', 'duplicate id'); names.add(f.id);
    validateIds(f.colorIds, 'sourceFeatures.colorIds', ids);
    integer(f.minCells, 'sourceFeatures.minCells', 1, 65536); finite(f.importance, 'sourceFeatures.importance', 0, 10); finite(f.confidence, 'sourceFeatures.confidence', 0, 1);
    if (typeof f.allowSingleton !== 'boolean') fail('sourceFeatures.allowSingleton', 'expected boolean');
    const mask = object(f.mask, 'sourceFeatures.mask', ['width', 'height', 'runs']);
    integer(mask.width, 'sourceFeatures.mask.width', 1, 4096); integer(mask.height, 'sourceFeatures.mask.height', 1, 4096);
    if (mask.width * mask.height > LIMITS.sourcePixels || (width !== undefined && mask.width !== width) || (height !== undefined && mask.height !== height)) fail('sourceFeatures.mask', 'wrong source frame');
    array(mask.runs, 'sourceFeatures.mask.runs', 1, 262144); totalRuns += mask.runs.length;
    if (totalRuns > 1_048_576) fail('sourceFeatures.mask.runs', 'too many runs');
    let end = 0;
    for (const run of mask.runs) {
      array(run, 'sourceFeatures.mask.run', 2, 2); integer(run[0], 'sourceFeatures.mask.start', 0, mask.width * mask.height - 1); integer(run[1], 'sourceFeatures.mask.length', 1, mask.width * mask.height);
      if (run[0] < end || run[0] + run[1] > mask.width * mask.height) fail('sourceFeatures.mask.run', 'overlapping, unsorted or out of bounds');
      end = run[0] + run[1];
    }
  }
}

export function validateSourceRaster(input: unknown): asserts input is SourceRaster {
  const raster = object(input, 'sourceRaster', ['schemaVersion', 'width', 'height', 'frameWidth', 'frameHeight', 'geometry', 'sourceHash', 'inputHash', 'configHash', 'cells', 'features', 'warnings', 'sampling', 'algorithmVersion'], ['schemaVersion', 'width', 'height', 'frameWidth', 'frameHeight', 'geometry', 'sourceHash', 'inputHash', 'configHash', 'cells', 'features', 'warnings']);
  version(raster.schemaVersion, 'sourceRaster.schemaVersion');
  if (raster.algorithmVersion !== undefined) integer(raster.algorithmVersion, 'sourceRaster.algorithmVersion', 3, 5);
  for (const key of ['width', 'height', 'frameWidth', 'frameHeight']) integer(raster[key], `sourceRaster.${key}`, 1, 256);
  for (const key of ['sourceHash', 'inputHash', 'configHash']) if (typeof raster[key] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raster[key] as string)) fail(`sourceRaster.${key}`, 'invalid hash');
  const geometry = object(raster.geometry, 'sourceRaster.geometry', ['sourceWidth', 'sourceHeight', 'fit', 'sourceToGrid', 'alphaCoverageThreshold', 'crop', 'phase', 'frameWidth', 'frameHeight'], ['sourceWidth', 'sourceHeight', 'fit', 'sourceToGrid', 'alphaCoverageThreshold']);
  integer(geometry.sourceWidth, 'sourceRaster.sourceWidth', 1, 4096); integer(geometry.sourceHeight, 'sourceRaster.sourceHeight', 1, 4096);
  if (geometry.sourceWidth * geometry.sourceHeight > LIMITS.sourcePixels) fail('sourceRaster.geometry', 'source frame exceeds limit');
  if (geometry.crop !== undefined) validateCrop(geometry.crop, geometry.sourceWidth, geometry.sourceHeight, 'sourceRaster.crop');
  if (geometry.phase !== undefined) { array(geometry.phase, 'sourceRaster.phase', 2, 2); geometry.phase.forEach(value => finite(value, 'sourceRaster.phase', -.49, .49)); }
  if (geometry.frameWidth !== undefined || geometry.frameHeight !== undefined) {
    if (geometry.frameWidth !== raster.frameWidth || geometry.frameHeight !== raster.frameHeight) fail('sourceRaster.geometry', 'frame mismatch');
  }
  const expected = patternGeometry(geometry.sourceWidth, geometry.sourceHeight, raster.frameWidth as number, raster.frameHeight as number, geometry.crop as PatternGeometry['crop'], geometry.phase as PatternGeometry['phase']);
  const { frameWidth: _fw, frameHeight: _fh, ...plainGeometry } = geometry;
  if (hashJson(plainGeometry) !== hashJson(expected)) fail('sourceRaster.geometry', 'invalid source transform');
  array(raster.cells, 'sourceRaster.cells', (raster.width as number) * (raster.height as number), (raster.width as number) * (raster.height as number));
  const color = (value: unknown) => { const c = object(value, 'sourceRaster.color', ['space', 'L', 'a', 'b']); if (c.space !== 'oklab') fail('sourceRaster.color', 'expected OKLab'); finite(c.L, 'sourceRaster.L', -.001, 1.001); finite(c.a, 'sourceRaster.a', -.5, .5); finite(c.b, 'sourceRaster.b', -.5, .5); };
  for (const value of raster.cells) {
    if (value === null) continue;
    const c = object(value, 'sourceRaster.cell', ['coverage', 'mean', 'representative', 'modes', 'edge', 'importance', 'sourceMean', 'weightedMean', 'sourceDominance', 'sourceEdge', 'sourceContrast', 'edgeReliability', 'samplingStrategy', 'sourceRightContrast', 'sourceRightReliability', 'sourceDownContrast', 'sourceDownReliability'], ['coverage', 'mean', 'representative', 'modes', 'edge', 'importance']);
    color(c.mean); color(c.representative); for (const key of ['sourceMean', 'weightedMean']) if (c[key] !== undefined) color(c[key]);
    for (const key of ['coverage', 'edge', 'sourceDominance', 'sourceEdge', 'sourceContrast', 'edgeReliability', 'sourceRightContrast', 'sourceRightReliability', 'sourceDownContrast', 'sourceDownReliability']) if (c[key] !== undefined) finite(c[key], `sourceRaster.${key}`, 0, 1);
    finite(c.importance, 'sourceRaster.importance', 0, 100);
    if (c.samplingStrategy !== undefined && !['dominant', 'mean', 'weighted-area', 'modes'].includes(c.samplingStrategy as string)) fail('sourceRaster.strategy', 'invalid strategy');
    array(c.modes, 'sourceRaster.modes', 1, 16); let sum = 0;
    for (const value of c.modes) { const m = object(value, 'sourceRaster.mode', ['color', 'weight', 'sourceWeight', 'structuralSupport', 'sourceContrast', 'boundarySupport', 'compactSupport', 'components'], ['color', 'weight']); color(m.color); finite(m.weight, 'sourceRaster.mode.weight', 0, 1.000001); sum += m.weight; for (const key of ['sourceWeight', 'structuralSupport', 'sourceContrast', 'boundarySupport', 'compactSupport']) if (m[key] !== undefined) finite(m[key], `sourceRaster.mode.${key}`, 0, 1);
      if (m.components !== undefined) { array(m.components, 'sourceRaster.mode.components', 0, 2); for (const entry of m.components) {
        const c = object(entry, 'sourceRaster.component', ['id', 'coverage', 'support', 'kind', 'span', 'endpointMask', 'closed', 'thickness', 'contrast'], ['id', 'coverage', 'support', 'kind', 'span']);
        integer(c.id, 'sourceRaster.component.id', 0, 4194303); finite(c.coverage, 'sourceRaster.component.coverage', 0, 1); finite(c.support, 'sourceRaster.component.support', 0, 1); finite(c.span, 'sourceRaster.component.span', 0, 4096);
        if (c.endpointMask !== undefined) integer(c.endpointMask, 'sourceRaster.component.endpointMask', 0, 3);
        if (c.closed !== undefined && typeof c.closed !== 'boolean') fail('sourceRaster.component.closed', 'expected boolean');
        if (c.thickness !== undefined) finite(c.thickness, 'sourceRaster.component.thickness', 0, 4096);
        if (c.contrast !== undefined) finite(c.contrast, 'sourceRaster.component.contrast', 0, 1);
        if (c.kind !== 'compact' && c.kind !== 'stroke' && c.kind !== 'region') fail('sourceRaster.component.kind', 'unknown kind');
      } }
    }
    if (Math.abs(sum - 1) > 1e-6) fail('sourceRaster.modes', 'weights must sum to one');
  }
  if (raster.sampling !== undefined) validateSamplingOptions(raster.sampling);
  validateCellConstraints(raster.features, raster.width as number, raster.height as number);
  array(raster.warnings, 'sourceRaster.warnings', 0, 128); raster.warnings.forEach(value => text(value, 'sourceRaster.warnings[]', 2048));
  const { configHash, ...content } = raster;
  if (hashJson(content) !== configHash) fail('sourceRaster.configHash', 'cached source evidence changed');
}

function finite(value: unknown, path: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `expected finite number in [${min}, ${max}]`);
}

function validateCrop(value: unknown, width: number, height: number, path: string): asserts value is [number, number, number, number] {
  array(value, path, 4, 4);
  value.forEach((entry, index) => integer(entry, `${path}[${index}]`, 0, index % 2 === 0 ? width : height));
  if ((value[2] as number) <= (value[0] as number) || (value[3] as number) <= (value[1] as number)) fail(path, 'crop must have positive area');
}

export function patternGeometry(sourceWidth: number, sourceHeight: number, width: number, height: number, crop?: [number, number, number, number], phase?: [number, number]): PatternGeometry {
  const [x0, y0, x1, y1] = crop ?? [0, 0, sourceWidth, sourceHeight];
  const cropWidth = x1 - x0, cropHeight = y1 - y0;
  const scale = Math.min(width / cropWidth, height / cropHeight);
  return {
    sourceWidth, sourceHeight, fit: 'contain',
    sourceToGrid: [scale, 0, (width - cropWidth * scale) / 2 - x0 * scale + (phase?.[0] ?? 0), 0, scale, (height - cropHeight * scale) / 2 - y0 * scale + (phase?.[1] ?? 0), 0, 0, 1],
    alphaCoverageThreshold: 0.5,
    ...(crop ? { crop: [...crop] as PatternGeometry['crop'] } : {}),
    ...(phase ? { phase: [...phase] as PatternGeometry['phase'] } : {}),
  };
}

export function validatePattern(input: unknown): asserts input is BeadPattern {
  const pattern = object(input, 'pattern', ['schemaVersion', 'width', 'height', 'cells', 'paletteHash', 'paletteSnapshot', 'inputRevision', 'configHash', 'geometry', 'diagnostics']);
  version(pattern.schemaVersion, 'pattern.schemaVersion');
  integer(pattern.width, 'pattern.width', 1, LIMITS.targetSide);
  integer(pattern.height, 'pattern.height', 1, LIMITS.targetSide);
  integer(pattern.inputRevision, 'pattern.inputRevision', 0, Number.MAX_SAFE_INTEGER);
  const palette = loadPalette(pattern.paletteSnapshot);
  if (pattern.paletteHash !== paletteHash(palette)) fail('pattern.paletteHash', 'does not match palette snapshot');
  if (typeof pattern.configHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(pattern.configHash)) fail('pattern.configHash', 'expected SHA-256 digest');
  array(pattern.cells, 'pattern.cells', pattern.width * pattern.height, pattern.width * pattern.height);
  const ids = new Set(palette.colors.map(color => color.id));
  for (const cell of pattern.cells) if (cell !== null && (typeof cell !== 'string' || !ids.has(cell))) fail('pattern.cells', 'unknown ColorId');
  const geometry = object(pattern.geometry, 'pattern.geometry', ['sourceWidth', 'sourceHeight', 'fit', 'sourceToGrid', 'alphaCoverageThreshold', 'crop', 'phase', 'frameWidth', 'frameHeight'], ['sourceWidth', 'sourceHeight', 'fit', 'sourceToGrid', 'alphaCoverageThreshold']);
  integer(geometry.sourceWidth, 'pattern.geometry.sourceWidth', 1, LIMITS.sourceSide);
  integer(geometry.sourceHeight, 'pattern.geometry.sourceHeight', 1, LIMITS.sourceSide);
  if (geometry.sourceWidth * geometry.sourceHeight > LIMITS.sourcePixels) fail('pattern.geometry', 'source too large');
  if (geometry.fit !== 'contain' || geometry.alphaCoverageThreshold !== 0.5) fail('pattern.geometry', 'unsupported geometry');
  array(geometry.sourceToGrid, 'pattern.geometry.sourceToGrid', 9, 9);
  if (geometry.crop !== undefined) validateCrop(geometry.crop, geometry.sourceWidth, geometry.sourceHeight, 'pattern.geometry.crop');
  if (geometry.phase !== undefined) {
    array(geometry.phase, 'pattern.geometry.phase', 2, 2);
    geometry.phase.forEach(value => finite(value, 'pattern.geometry.phase[]', -0.49, 0.49));
  }
  if (geometry.frameWidth !== undefined || geometry.frameHeight !== undefined) { integer(geometry.frameWidth, 'pattern.geometry.frameWidth', 1, 256); integer(geometry.frameHeight, 'pattern.geometry.frameHeight', 1, 256); }
  const expected = patternGeometry(geometry.sourceWidth, geometry.sourceHeight, (geometry.frameWidth ?? pattern.width) as number, (geometry.frameHeight ?? pattern.height) as number, geometry.crop as PatternGeometry['crop'], geometry.phase as PatternGeometry['phase']);
  geometry.sourceToGrid.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value - expected.sourceToGrid[index]) > 1e-12) fail('pattern.geometry.sourceToGrid', 'inconsistent contain transform');
  });
  const diagnostics = object(pattern.diagnostics, 'pattern.diagnostics', ['usedColors', 'physicalComponents', 'monochromeSingletons', 'colorReduction', 'warnings', 'optimization', 'diagonalContacts', 'narrowConnections', 'sampling'], ['usedColors', 'physicalComponents', 'monochromeSingletons', 'colorReduction', 'warnings']);
  const counts = inspectCells(pattern.cells as BeadPattern['cells'], pattern.width, pattern.height);
  for (const key of ['usedColors', 'physicalComponents', 'monochromeSingletons'] as const) {
    if (diagnostics[key] !== counts[key]) fail(`pattern.diagnostics.${key}`, 'does not match cells');
  }
  if (!['none', 'frequency-subpalette', 'optimized-subpalette'].includes(diagnostics.colorReduction as string)) fail('pattern.diagnostics.colorReduction', 'unsupported color reduction');
  array(diagnostics.warnings, 'pattern.diagnostics.warnings', 0, 32);
  for (const warning of diagnostics.warnings) text(warning, 'pattern.diagnostics.warnings[]', 2048);
  const connectivity = inspectConnectivity(pattern.cells as BeadPattern['cells'], pattern.width, pattern.height);
  for (const key of ['diagonalContacts', 'narrowConnections'] as const) if (diagnostics[key] !== undefined && diagnostics[key] !== connectivity[key]) fail(`pattern.diagnostics.${key}`, 'does not match cells');
  if (diagnostics.sampling !== undefined) {
    const sampling = object(diagnostics.sampling, 'pattern.diagnostics.sampling', ['multimodalCells', 'minorityCandidates']);
    for (const key of ['multimodalCells', 'minorityCandidates']) integer(sampling[key], `pattern.diagnostics.sampling.${key}`, 0, pattern.width * pattern.height);
  }
  if (diagnostics.optimization !== undefined) {
    const report = object(diagnostics.optimization, 'pattern.diagnostics.optimization', ['preset', 'initialEnergy', 'finalEnergy', 'terms', 'iterations', 'evaluations', 'stopReason', 'trace', 'hardConstraintsSatisfied', 'runs', 'seed', 'bestRun'], ['preset', 'initialEnergy', 'finalEnergy', 'terms', 'iterations', 'evaluations', 'stopReason', 'trace', 'hardConstraintsSatisfied']);
    if (!['accurate', 'clean', 'pixel-art'].includes(report.preset as string)) fail('pattern.diagnostics.optimization.preset', 'unknown preset');
    finite(report.initialEnergy, 'pattern.diagnostics.optimization.initialEnergy', 0, 1e6);
    finite(report.finalEnergy, 'pattern.diagnostics.optimization.finalEnergy', 0, 1e6);
    if (report.finalEnergy > report.initialEnergy + 1e-9) fail('pattern.diagnostics.optimization.finalEnergy', 'energy increased');
    integer(report.iterations, 'pattern.diagnostics.optimization.iterations', 0, 30);
    integer(report.evaluations, 'pattern.diagnostics.optimization.evaluations', 0, 2_000_000);
    if (!['converged', 'iteration-budget', 'evaluation-budget', 'empty'].includes(report.stopReason as string)) fail('pattern.diagnostics.optimization.stopReason', 'unknown stop reason');
    if (report.hardConstraintsSatisfied !== true) fail('pattern.diagnostics.optimization.hardConstraintsSatisfied', 'expected feasible result');
    const terms = object(report.terms, 'pattern.diagnostics.optimization.terms', ['color', 'smooth', 'edge', 'island', 'palette', 'feature', 'symmetry', 'total']);
    for (const key of Object.keys(terms)) finite(terms[key], `pattern.diagnostics.optimization.terms.${key}`, 0, 1e6);
    const total = Object.entries(terms).filter(([key]) => key !== 'total').reduce((sum, [, value]) => sum + (value as number), 0);
    if (Math.abs(total - (terms.total as number)) > 1e-9 || Math.abs(total - report.finalEnergy) > 1e-9) fail('pattern.diagnostics.optimization.terms', 'inconsistent total');
    array(report.trace, 'pattern.diagnostics.optimization.trace', 1, 1000);
    let previous = report.initialEnergy;
    report.trace.forEach(value => { finite(value, 'pattern.diagnostics.optimization.trace[]', 0, 1e6); if (value > previous + 1e-9) fail('pattern.diagnostics.optimization.trace', 'energy increased'); previous = value; });
    if (Math.abs((report.trace[0] as number) - report.initialEnergy) > 1e-9 || Math.abs(previous - report.finalEnergy) > 1e-9) fail('pattern.diagnostics.optimization.trace', 'inconsistent endpoints');
    if (report.seed !== undefined) integer(report.seed, 'optimization.seed', 0, 0xffffffff);
    if (report.runs !== undefined) {
      array(report.runs, 'optimization.runs', 1, 8);
      integer(report.bestRun, 'optimization.bestRun', 0, report.runs.length - 1);
      let evaluations = 0, iterations = 0, best = Infinity;
      for (const value of report.runs) {
        const run = object(value, 'optimization.run', ['initialization', 'initialEnergy', 'finalEnergy', 'evaluations', 'iterations', 'stopReason', 'trace'], ['initialization', 'initialEnergy', 'finalEnergy', 'evaluations', 'iterations', 'stopReason']);
        text(run.initialization, 'optimization.run.initialization', 128);
        finite(run.initialEnergy, 'optimization.run.initialEnergy', 0, 1e6); finite(run.finalEnergy, 'optimization.run.finalEnergy', 0, 1e6);
        if (run.finalEnergy > run.initialEnergy + 1e-9) fail('optimization.run', 'energy increased');
        integer(run.evaluations, 'optimization.run.evaluations', 0, 2_000_000); integer(run.iterations, 'optimization.run.iterations', 0, 30);
        if (!['converged', 'iteration-budget', 'evaluation-budget', 'empty'].includes(run.stopReason as string)) fail('optimization.run.stopReason', 'unknown reason');
        evaluations += run.evaluations; iterations += run.iterations; best = Math.min(best, run.finalEnergy);
        if (run.trace !== undefined) {
          array(run.trace, 'optimization.run.trace', 1, 1000); let last = run.initialEnergy;
          for (const energy of run.trace) { finite(energy, 'optimization.run.trace[]', 0, 1e6); if (energy > last + 1e-9) fail('optimization.run.trace', 'energy increased'); last = energy; }
          if (Math.abs((run.trace[0] as number) - run.initialEnergy) > 1e-9 || Math.abs(last - run.finalEnergy) > 1e-9) fail('optimization.run.trace', 'inconsistent endpoints');
        }
      }
      if (evaluations !== report.evaluations || iterations !== report.iterations || Math.abs(best - report.finalEnergy) > 1e-9) fail('optimization.runs', 'inconsistent totals');
      const chosen = report.runs[report.bestRun] as Record<string, number>;
      if (Math.abs(chosen.finalEnergy - report.finalEnergy) > 1e-9) fail('optimization.bestRun', 'does not select best result');
    } else if (report.bestRun !== undefined) fail('optimization.bestRun', 'requires runs');
  }
}

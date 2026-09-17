import type { BeadPattern, Bom, GenerationRequest, GenerationRequestJson, Palette, TextAnalysis, CellConstraint } from '../contracts';
import { compareColorIds, nearestColor, prepareColors } from './color';
import { hashJson, sha256 } from './hash';
import { inspectCells, inspectConnectivity } from './grid';
import { sampleImage, sampleStructuredImage, smoothImage } from './sampling';
import { optimizePattern } from './optimizer';
import { prepareImage } from './preprocess';
import { createSourceRaster } from './source-raster';
import { canonicalPalette, loadPalette, paletteHash, patternGeometry, validatePattern, validateRequest, ValidationError } from './validation';
import { buildTextSystem, textRegionHealth } from './text-system';
import { validateTextAnalysis } from './text-analysis';
import type { ProgressObserver } from './progress';

export * from './color';
export * from './sampling';
export * from './optimizer';
export * from './preprocess';
export * from './source-raster';
export * from './text-analysis';
export * from './text-extraction';
export { LIMITS, loadPalette, paletteHash, validatePattern, validateRequest, ValidationError } from './validation';

/** Pure deterministic CPU engine. Input RGBA must be orientation-correct sRGB.
 * Requests without optional P2/P3 settings retain the frozen B0/B1 behavior. */
export function generatePattern(request: GenerationRequest, onProgress?: ProgressObserver): BeadPattern {
  validateRequest(request);
  onProgress?.({ stage: 'sampling', completed: 0, total: 3 });
  const palette = canonicalPalette(loadPalette(request.palette));
  const allowed = new Set(request.allowedColors ?? palette.colors.map(color => color.id));
  const prepared = prepareColors(palette.colors.filter(color => allowed.has(color.id)));
  const structured = request.method === 'dominant' || request.method === 'optimized';
  const raster = structured ? request.preparedRaster ?? createSourceRaster(request) : undefined;
  const preparedImage = !structured && request.preprocessing ? prepareImage(request.image, request.preprocessing).image : request.image;
  const image = !structured && request.preprocessing?.smoothing && request.style !== 'pixel-input' ? smoothImage(preparedImage) : preparedImage;
  const geometry = raster ? { ...raster.geometry, ...(raster.width !== raster.frameWidth || raster.height !== raster.frameHeight ? { frameWidth: raster.frameWidth, frameHeight: raster.frameHeight } : {}) }
    : patternGeometry(request.image.width, request.image.height, request.width, request.height, request.preprocessing?.crop, request.phase);
  const samplingGeometry = patternGeometry(image.width, image.height, request.width, request.height, undefined, request.phase);
  const target = raster?.cells;
  const samples = target ? target.map(cell => cell?.representative ?? null) : sampleImage(image, request.width, request.height, samplingGeometry, request.method as 'nearest' | 'area');
  let cells = samples.map(sample => sample === null ? null : nearestColor(sample, prepared));
  const frequencies = new Map<string, number>();
  for (const cell of cells) if (cell !== null) frequencies.set(cell, (frequencies.get(cell) ?? 0) + 1);
  const warnings: string[] = [...(raster?.warnings ?? [])];
  if (request.preparedRaster && (request.preparedRaster.algorithmVersion ?? 3) < 5) warnings.push('Cached source detail predates source line and shape evidence; select the original image again to rebuild it.');
  if (request.preprocessing?.smoothing && request.style === 'pixel-input') warnings.push('Pixel input bypasses optional smoothing to preserve original pixels.');
  let colorReduction: BeadPattern['diagnostics']['colorReduction'] = 'none';
  let optimization: BeadPattern['diagnostics']['optimization'];
  if (request.method === 'optimized') {
    onProgress?.({ stage: 'optimizing', completed: 1, total: 3 });
    const result = optimizePattern({ ...request, sampling: request.sampling ?? request.preparedRaster?.sampling, constraints: [...(raster?.features ?? []), ...(request.constraints ?? [])] }, target!, prepared, undefined,
      onProgress ? (evaluations, maxEvaluations) => onProgress({ stage: 'optimizing', completed: 1 + evaluations / maxEvaluations, total: 3, evaluations, maxEvaluations }) : undefined);
    cells = result.cells; optimization = result.report; warnings.push(...result.warnings);
    colorReduction = 'optimized-subpalette';
  } else if (frequencies.size > request.maxColors) {
    const selected = new Set([...frequencies].sort((a, b) => b[1] - a[1] || compareColorIds(a[0], b[0]))
      .slice(0, request.maxColors).map(([id]) => id));
    const subset = prepared.filter(color => selected.has(color.id));
    cells = samples.map(sample => sample === null ? null : nearestColor(sample, subset));
    colorReduction = 'frequency-subpalette';
    warnings.push('Color budget uses deterministic frequency selection and rematching; no structure optimizer was applied.');
  }
  onProgress?.({ stage: 'finalizing', completed: 2, total: 3 });
  if (palette.approximate) warnings.push('Palette RGB values are approximate; physical bead colors may differ.');
  if (cells.every(cell => cell === null)) warnings.push('No cells reach the 50% alpha threshold; the pattern is empty.');
  const modern = structured || request.preprocessing !== undefined || request.phase !== undefined || request.style !== undefined;
  const connectivity = modern ? inspectConnectivity(cells, request.width, request.height) : undefined;
  if (connectivity?.diagonalContacts) warnings.push(`${connectivity.diagonalContacts} diagonal-only contact(s) may need separate assembly.`);
  if (connectivity?.narrowConnections) warnings.push(`${connectivity.narrowConnections} narrow connection(s) may be fragile; no bridges were added.`);
  const paletteDigest = paletteHash(palette);
  const configHash = hashJson({
    engineVersion: structured ? 'beadify-structure-v5' : modern ? 'beadify-structure-v2' : 'beadify-baseline-v1', schemaVersion: request.schemaVersion,
    image: { width: request.image.width, height: request.image.height, sha256: sha256(request.image.data) },
    width: request.width, height: request.height, paletteHash: paletteDigest,
    method: request.method, maxColors: request.maxColors, allowedColors: [...allowed].sort(compareColorIds),
    geometry,
    ...(structured ? { sampling: request.sampling ?? {}, sourceFeatures: request.sourceFeatures ?? [], preparedRasterHash: request.preparedRaster?.configHash ?? null } : {}),
    ...(modern ? { preprocessing: request.preprocessing ?? null, style: request.style ?? 'clean', phase: request.phase ?? null, requiredColors: [...(request.requiredColors ?? [])].sort(compareColorIds), constraints: request.constraints ?? [], optimization: request.optimization ?? {} } : {}),
  });
  const pattern: BeadPattern = {
    schemaVersion: 1, width: request.width, height: request.height, cells,
    paletteHash: paletteDigest, paletteSnapshot: palette, inputRevision: request.revision, configHash, geometry,
    diagnostics: {
      ...inspectCells(cells, request.width, request.height), colorReduction,
      warnings: warnings.length <= 32 ? warnings : [...warnings.slice(0, 31), `${warnings.length - 31} additional diagnostics omitted.`],
      ...(optimization ? { optimization } : {}), ...(connectivity ?? {}),
      ...(target ? { sampling: {
        multimodalCells: target.filter(cell => cell && cell.modes.length > 1).length,
        minorityCandidates: target.filter(cell => cell && cell.modes.some(mode => mode.weight < 0.25 && Math.hypot(mode.color.L - cell.representative.L, mode.color.a - cell.representative.a, mode.color.b - cell.representative.b) > 0.18)).length,
      } } : {}),
    },
  };
  onProgress?.({ stage: 'complete', completed: 3, total: 3 });
  return pattern;
}

/** BOM is derived only from the final grid; callers may provide its matching snapshot. */
export function buildBom(pattern: BeadPattern, paletteInput: Palette = pattern.paletteSnapshot): Bom {
  validatePattern(pattern);
  const palette = loadPalette(paletteInput);
  if (paletteHash(palette) !== pattern.paletteHash) throw new ValidationError('palette', 'does not match pattern palette snapshot');
  const counts = new Map<string, number>();
  for (const cell of pattern.cells) if (cell !== null) counts.set(cell, (counts.get(cell) ?? 0) + 1);
  const rows: Bom['rows'] = canonicalPalette(palette).colors.filter(color => counts.has(color.id)).map(color => ({
    colorId: color.id, brand: color.brand, series: color.series, code: color.code,
    srgb8: [...color.srgb8], count: counts.get(color.id)!,
  }));
  return { schemaVersion: 1, paletteHash: pattern.paletteHash, totalBeads: rows.reduce((sum, row) => sum + row.count, 0), rows };
}

export function toJsonRequest(request: GenerationRequest): GenerationRequestJson {
  validateRequest(request);
  return JSON.parse(JSON.stringify({ ...request, image: { ...request.image, data: Array.from(request.image.data) } })) as GenerationRequestJson;
}

/** Optional original-glyph candidate. The current grid is an explicit seed;
 * every external cell/empty cell is locked through the shared optimizer. */
export function generateTextCandidate(request: GenerationRequest, analysis: TextAnalysis, initialPattern?: BeadPattern, onProgress?: ProgressObserver) {
  validateRequest(request); validateTextAnalysis(analysis);
  if (request.method !== 'optimized' || request.preparedRaster) throw new ValidationError('text', 'text candidates require optimized generation and the original image, not a legacy raster cache');
  const base = initialPattern ?? generatePattern(request); validatePattern(base);
  if (base.width !== request.width || base.height !== request.height || base.paletteHash !== paletteHash(request.palette) || base.inputRevision !== request.revision) throw new ValidationError('text.base', 'grid, palette or revision mismatch');
  const expectedGeometry = patternGeometry(request.image.width, request.image.height, request.width, request.height, request.preprocessing?.crop, request.phase);
  if (hashJson(base.geometry) !== hashJson(expectedGeometry)) throw new ValidationError('text.base.geometry', 'source crop, layout or phase changed; regenerate the ordinary candidate first');
  const colors = prepareColors(canonicalPalette(request.palette).colors.filter(c => !request.allowedColors || request.allowedColors.includes(c.id)));
  onProgress?.({ stage: 'text-evidence', completed: 0, total: 4 });
  const system = buildTextSystem(request, analysis, base, colors);
  if (!system.regions.length || !system.writable.size || request.optimization?.weights?.feature === 0 || request.style === 'pixel-input') {
    onProgress?.({ stage: 'complete', completed: 4, total: 4 });
    return { pattern: base, status: 'UNCHANGED' as const, writableCells: [] as number[], changedCells: [] as number[], diagnostics: system.diagnostics, health: [] };
  }
  const locks = new Map<string | null, number[]>();
  base.cells.forEach((color, i) => { if (!system.writable.has(i) || color === null) { const indices = locks.get(color) ?? []; indices.push(i); locks.set(color, indices); } });
  const outside: CellConstraint[] = [...locks].map(([color, cellIndices]) => color === null ? { kind: 'lock-empty', cellIndices } : { kind: 'lock-color', colorId: color, cellIndices });
  onProgress?.({ stage: 'source-cache', completed: 1, total: 4 });
  const raster = createSourceRaster(request);
  const constrained: GenerationRequest = { ...request, constraints: [...raster.features, ...(request.constraints ?? []), ...outside] };
  validateRequest(constrained);
  onProgress?.({ stage: 'optimizing', completed: 2, total: 4 });
  const result = optimizePattern(constrained, raster.cells, colors, system,
    onProgress ? (evaluations, maxEvaluations) => onProgress({ stage: 'optimizing', completed: 2 + evaluations / maxEvaluations, total: 4, evaluations, maxEvaluations }) : undefined);
  onProgress?.({ stage: 'finalizing', completed: 3, total: 4 });
  const changedCells = result.cells.flatMap((id, i) => id !== base.cells[i] ? [i] : []);
  const warnings = [...base.diagnostics.warnings, ...result.warnings, 'Text candidate uses original pixels and verified source masks; transcription is not used to redraw glyphs.'].slice(0, 32);
  const pattern: BeadPattern = { ...base, cells: result.cells, configHash: hashJson({ engine: 'beadify-text-v1', base: base.configHash, text: system.hash,
    settings: { optimization: request.optimization ?? {}, style: request.style ?? 'clean', allowedColors: request.allowedColors ?? null, requiredColors: request.requiredColors ?? [], constraints: request.constraints ?? [], raster: raster.configHash } }),
    diagnostics: { ...base.diagnostics, ...inspectCells(result.cells, request.width, request.height), ...inspectConnectivity(result.cells, request.width, request.height), optimization: result.report, warnings } };
  validatePattern(pattern);
  onProgress?.({ stage: 'complete', completed: 4, total: 4 });
  return { pattern, status: changedCells.length ? 'CANDIDATE' as const : 'UNCHANGED' as const, writableCells: [...system.writable].sort((a, b) => a - b), changedCells,
    diagnostics: system.diagnostics, health: system.regions.map(r => ({ regionId: r.id, before: r.baselineHealth, after: textRegionHealth(r, result.cells, request.width, request.height) })) };
}

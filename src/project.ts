import { completePalette, getColor, paletteVersion } from './palette';
import { loadPalette } from './beadify/core/index';
import { validateCellConstraints, validateOptimizationOptions, validateSamplingOptions, validateSourceFeatures, validateSourceRaster } from './beadify/core/validation';
import { resizeSourceRaster } from './beadify/core/source-raster';
import type { BeadLayer, BeadProject, PaletteColor } from './types';
import type { Palette } from './beadify/contracts/index';
import { workspacePalette } from './beadify/adapter';

import { validateTextAnalysis } from './beadify/core/text-analysis';
import { validateSceneAnalysis } from './beadify/core/scene-analysis';
import { validateTextRetype } from './beadify/text-retype';
export const autosaveKey = 'perler-beads-generator:draft';

export function createProject(width = 52, height = 52, name = 'Untitled Pattern'): BeadProject {
  const now = new Date().toISOString();
  const cells = emptyCells(width, height);
  return {
    version: '1.0.0',
    name,
    width,
    height,
    activeBrand: 'MARD',
    paletteVersion,
    cells,
    layers: [
      {
        id: 'base',
        name: 'Pattern',
        customName: false,
        visible: true,
        locked: false,
        includeInUsage: true,
        opacity: 1,
        cells,
      },
    ],
    activeLayerId: 'base',
    settings: {
      showGrid: true,
      showCoordinates: true,
      showPegboardBoundaries: true,
      showLayerOverlap: false,
      showActiveLayerOnly: false,
      showColorCodes: false,
      beadDisplayMode: 'bead',
      beadsPerPack: 500,
      rightClickAction: 'pan',
    },
    boardSettings: {
      boardWidth: 52,
      boardHeight: 52,
      showBoardIds: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function withCells(project: BeadProject, cells: Array<string | null>, width = project.width, height = project.height): BeadProject {
  const normalizedCells = normalizeCells(cells, width, height);
  const layers = normalizeLayers(project, width, height).map((layer) =>
    layer.id === project.activeLayerId && !layer.locked ? { ...layer, cells: normalizedCells } : layer,
  );
  return {
    ...project,
    ...(project.beadify?.sourceRaster ? { beadify: { ...project.beadify, sourceRaster: resizeSourceRaster(project.beadify.sourceRaster, width, height) } } : {}),
    width,
    height,
    cells: composeVisibleCells(layers, width, height),
    layers,
    updatedAt: new Date().toISOString(),
  };
}

export function createLayer(width: number, height: number, name: string): BeadLayer {
  return {
    id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    customName: false,
    visible: true,
    locked: false,
    includeInUsage: true,
    opacity: 1,
    cells: emptyCells(width, height),
  };
}

export function withLayers(project: BeadProject, layers: BeadLayer[], activeLayerId = project.activeLayerId): BeadProject {
  const normalizedLayers = normalizeLayers({ ...project, layers }, project.width, project.height);
  const nextActiveLayerId = normalizedLayers.some((layer) => layer.id === activeLayerId)
    ? activeLayerId
    : normalizedLayers[0]?.id ?? 'base';
  return {
    ...project,
    layers: normalizedLayers,
    activeLayerId: nextActiveLayerId,
    cells: composeVisibleCells(normalizedLayers, project.width, project.height),
    updatedAt: new Date().toISOString(),
  };
}

export function composeVisibleCells(layers: BeadLayer[], width: number, height: number): Array<string | null> {
  const result = emptyCells(width, height);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const cells = normalizeCells(layer.cells, width, height);
    cells.forEach((cell, index) => {
      if (cell) result[index] = cell;
    });
  }
  return result;
}

export function normalizeProject(input: unknown): BeadProject {
  validateProject(input);
  const project = input;
  const { width, height } = project;
  const fallback = createProject(width, height, project.name);
  const settings = {
    ...fallback.settings,
    ...project.settings,
    showColorCodes: Boolean(project.settings?.showColorCodes || project.settings?.beadDisplayMode === 'print'),
    beadDisplayMode: project.settings?.beadDisplayMode === 'pixel' ? 'pixel' : 'bead',
  } satisfies BeadProject['settings'];
  const layers = normalizeLayers(
    {
      ...fallback,
      ...project,
      settings,
      boardSettings: { ...fallback.boardSettings, ...project.boardSettings },
      layers: project.layers?.length ? project.layers : [{ ...fallback.layers[0], cells: project.cells.slice() }],
    },
    width,
    height,
  );
  return {
    ...fallback,
    ...project,
    width,
    height,
    activeBrand: 'MARD',
    ...(project.beadify ? { beadify: JSON.parse(JSON.stringify(project.beadify)) } : {}),
    settings,
    boardSettings: { ...fallback.boardSettings, ...project.boardSettings },
    layers,
    activeLayerId: layers.some((layer) => layer.id === project.activeLayerId) ? project.activeLayerId : layers[0].id,
    cells: composeVisibleCells(layers, width, height),
  };
}

// Import is a trust boundary: reject malformed grids before allocation or rendering.
const knownColorIds = new Set(completePalette.map((color) => color.id));

function validateProject(input: unknown): asserts input is BeadProject {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const reject = (message: string): never => { throw new Error(`Invalid project: ${message}`); };
  const side = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 256;
  if (!record(input) || !side(input.width) || !side(input.height)) reject('width and height must be integers in [1, 256]');
  const project = input as Record<string, unknown>;
  if (project.version !== undefined && project.version !== '1.0.0') reject('unsupported project version');
  let snapshot: Palette | undefined;
  try { snapshot = project.beadify === undefined ? undefined : validateMetadata(project.beadify, project.width as number, project.height as number); }
  catch (error) { reject(error instanceof Error ? error.message.replace(/^Invalid project: /, '') : 'invalid metadata'); }
  const colorIds = new Set(knownColorIds);
  snapshot?.colors.forEach(color => colorIds.add(workspaceColorId(color)));
  const length = (project.width as number) * (project.height as number);
  const cells = (value: unknown, path: string) => {
    if (!Array.isArray(value) || value.length !== length) reject(`${path} must contain exactly ${length} cells`);
    for (const cell of value as unknown[]) {
      if (cell !== null && (typeof cell !== 'string' || !colorIds.has(cell))) reject(`${path} contains an unknown color; expected a known MARD ID or null`);
    }
  };
  cells(project.cells, 'cells');
  if (project.name !== undefined && typeof project.name !== 'string') reject('name must be a string');
  if (project.layers !== undefined) {
    if (!Array.isArray(project.layers) || project.layers.length > 100) reject('layers must be an array of at most 100 layers');
    const ids = new Set<string>();
    for (const layer of project.layers as unknown[]) {
      if (!record(layer) || typeof layer.id !== 'string' || !layer.id || typeof layer.name !== 'string') reject('each layer needs an id and name');
      const entry = layer as Record<string, unknown>;
      if (ids.has(entry.id as string)) reject('duplicate layer id');
      ids.add(entry.id as string);
      cells(entry.cells, 'layer.cells');
      for (const key of ['visible', 'locked', 'includeInUsage']) if (typeof entry[key] !== 'boolean') reject(`layer.${key} must be boolean`);
      if (typeof entry.opacity !== 'number' || !Number.isFinite(entry.opacity) || entry.opacity < 0 || entry.opacity > 1) reject('layer.opacity must be in [0, 1]');
    }
    if ((project.layers as BeadLayer[]).length) {
      const composite = composeVisibleCells(project.layers as BeadLayer[], project.width as number, project.height as number);
      if (composite.some((cell, index) => cell !== (project.cells as unknown[])[index])) {
        // Earlier versions cached zero-opacity layers as visible. Preserve those
        // layer cells, but migrate the cached physical grid to current visibility.
        const legacy = composeVisibleCells((project.layers as BeadLayer[]).map(layer => ({ ...layer, opacity: 1 })), project.width as number, project.height as number);
        if (legacy.some((cell, index) => cell !== (project.cells as unknown[])[index])) reject('cells do not match visible layers');
      }
    }
  }
  for (const key of ['settings', 'boardSettings']) if (project[key] !== undefined && !record(project[key])) reject(`${key} must be an object`);
  const settings = (project.settings ?? {}) as Record<string, unknown>;
  for (const key of ['showGrid', 'showCoordinates', 'showPegboardBoundaries', 'showLayerOverlap', 'showActiveLayerOnly', 'showColorCodes']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') reject(`settings.${key} must be boolean`);
  }
  if (settings.beadsPerPack !== undefined && (typeof settings.beadsPerPack !== 'number' || !Number.isSafeInteger(settings.beadsPerPack) || settings.beadsPerPack < 1)) reject('beadsPerPack must be a positive integer');
  const board = (project.boardSettings ?? {}) as Record<string, unknown>;
  for (const key of ['boardWidth', 'boardHeight']) if (board[key] !== undefined && !side(board[key])) reject(`${key} must be an integer in [1, 256]`);

}

function normalizeLayers(project: BeadProject, width: number, height: number): BeadLayer[] {
  const legacyCells = normalizeCells(project.cells, width, height);
  const sourceLayers = project.layers?.length ? project.layers : [{ ...createProject(width, height).layers[0], cells: legacyCells }];
  return sourceLayers.map((layer, index) => ({
    ...layer,
    customName: Boolean(layer.customName),
    cells: normalizeCells(layer.cells ?? (index === 0 ? legacyCells : []), width, height),
  }));
}

function normalizeCells(cells: Array<string | null> | undefined, width: number, height: number): Array<string | null> {
  const length = width * height;
  const next = Array.from({ length }, (_, index) => cells?.[index] ?? null);
  return next;
}

function emptyCells(width: number, height: number): Array<string | null> {
  return Array.from({ length: width * height }, () => null);
}

export interface ProjectSerializationStatus { json: string; sourceRasterOmitted: boolean; textAnalysisOmitted?: boolean; reason?: 'file-budget' | 'storage-quota' }
export interface DraftSaveStatus { saved: boolean; sourceRasterOmitted: boolean; textAnalysisOmitted?: boolean; reason?: 'file-budget' | 'storage-quota' }
export const PROJECT_JSON_MAX_BYTES = 20 * 1024 * 1024;

export function saveDraftWithStatus(project: BeadProject): DraftSaveStatus {
  let serialized: ProjectSerializationStatus;
  try {
    serialized = serializeProjectWithStatus(project);
    for (;;) {
      try { localStorage.setItem(autosaveKey, serialized.json); break; }
      catch (error) {
        const details = error as { name?: string; code?: number };
        const quota = details?.name === 'QuotaExceededError' || details?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || details?.code === 22 || details?.code === 1014;
        if (!quota) throw error;
        if (project.beadify?.sourceRaster && !serialized.sourceRasterOmitted) serialized = serializeProjectWithStatus(project, { omitSourceRaster: 'storage-quota' });
        else if (project.beadify?.textAnalysis && !serialized.textAnalysisOmitted) serialized = serializeProjectWithStatus(project, { omitSourceRaster: 'storage-quota', omitTextAnalysis: 'storage-quota' });
        else throw error;
      }
    }
    return { saved: true, sourceRasterOmitted: serialized.sourceRasterOmitted, ...(serialized.textAnalysisOmitted ? { textAnalysisOmitted: true } : {}), ...(serialized.reason ? { reason: serialized.reason } : {}) };
  } catch { return { saved: false, sourceRasterOmitted: false }; }
}

/** Compatibility wrapper for callers that only need the save success flag. */
export function saveDraft(project: BeadProject): boolean { return saveDraftWithStatus(project).saved; }

export function loadDraft(): BeadProject | null {
  try {
    const raw = localStorage.getItem(autosaveKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BeadProject;
    return normalizeProject(parsed);
  } catch {
    try { localStorage.removeItem(autosaveKey); } catch { /* Storage can be unavailable in private browser modes. */ }
    return null;
  }
}

const snapshotColorCache = new WeakMap<Palette, Map<string, PaletteColor>>();
function workspaceColorId(color: Palette['colors'][number]): string { return `mard-${color.code.toLowerCase()}`; }

/** Saved RGB values take precedence over the installed palette, including in editors. */
export function projectColor(project: BeadProject, id: string | null): PaletteColor | undefined {
  if (!id) return undefined;
  const snapshot = project.beadify?.paletteSnapshot;
  if (!snapshot) return getColor(id);
  let colors = snapshotColorCache.get(snapshot);
  if (!colors) {
    colors = new Map(snapshot.colors.map((entry) => {
      const colorId = workspaceColorId(entry);
      const current = getColor(colorId);
      const rgb: [number, number, number] = [...entry.srgb8];
      return [colorId, {
        ...current, id: colorId, primaryBrand: 'MARD', primaryCode: entry.code,
        rgb, hex: `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`,
        codes: { ...current?.codes, MARD: entry.code }, group: current?.group ?? 'Saved',
        name: entry.name ?? current?.name ?? entry.code,
      }];
    }));
    snapshotColorCache.set(snapshot, colors);
  }
  return colors.get(id) ?? getColor(id);
}

/** Capture every edited layer's colors, so even hidden work survives palette updates. */
export function projectWithSnapshot(project: BeadProject): BeadProject {
  const existing = project.beadify?.paletteSnapshot;
  const ids = new Set((existing?.colors ?? []).map(workspaceColorId));
  const additions: PaletteColor[] = [];
  for (const cell of (project.layers?.length ? project.layers.flatMap(layer => layer.cells) : project.cells)) {
    if (!cell || ids.has(cell)) continue;
    const color = projectColor(project, cell);
    if (!color) throw new Error(`Unknown project color: ${cell}`);
    ids.add(cell); additions.push(color);
  }
  const extra = !existing || additions.length ? workspacePalette(additions.length ? additions : completePalette) : undefined;
  const paletteSnapshot = existing
    ? loadPalette({ ...existing, colors: [...existing.colors, ...(additions.length ? extra!.colors : [])] })
    : extra!;
  return { ...project, cells: composeVisibleCells(project.layers, project.width, project.height), beadify: {
    ...project.beadify, schemaVersion: 1, paletteSnapshot,
    lastGeneration: project.beadify?.lastGeneration ?? { method: 'original', inputRevision: 0, configHash: null },
  } };
}

function utf8Bytes(value: string): number {
  let size = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) size++;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
    else size += 3;
  }
  return size;
}

/** Count large cache arrays one entry at a time, stopping before serializing or
 * hashing an oversized full raster. Individual valid cells/constraints are bounded. */
function boundedRasterBytes(raster: NonNullable<BeadProject['beadify']>['sourceRaster'], limit: number): number | null {
  let size = 2, properties = 0;
  for (const [key, value] of Object.entries(raster ?? {})) {
    if (value === undefined) continue;
    size += utf8Bytes(JSON.stringify(key)) + 1 + Number(properties++ > 0);
    if (Array.isArray(value)) {
      size += 2;
      for (let index = 0; index < value.length; index++) {
        size += Number(index > 0) + utf8Bytes(JSON.stringify(value[index]) ?? 'null');
        if (size > limit) return null;
      }
    } else size += utf8Bytes(JSON.stringify(value));
    if (size > limit) return null;
  }
  return size;
}

export function serializeProjectWithStatus(project: BeadProject, options: { omitSourceRaster?: 'storage-quota'; omitTextAnalysis?: 'storage-quota' } = {}): ProjectSerializationStatus {
  const snapshot = projectWithSnapshot(project), { sourceRaster, ...metadata } = snapshot.beadify!;
  const omitText = (reason: 'storage-quota' | 'file-budget'): ProjectSerializationStatus => {
    const { textAnalysis: _analysis, ...retained } = snapshot.beadify!;
    const result = serializeProjectWithStatus({ ...snapshot, beadify: { ...retained, textAnalysisOmission: reason } }, options);
    return { ...result, textAnalysisOmitted: true };
  };
  if (metadata.textAnalysis) {
    validateTextAnalysis(metadata.textAnalysis);
    delete metadata.textAnalysisOmission;
    if (options.omitTextAnalysis) return omitText(options.omitTextAnalysis);
  }
  // Grid/layers, saved palette, source settings and manual constraints are the
  // document. Optional source evidence must not prevent saving that document.
  if (sourceRaster) delete metadata.sourceRasterOmission;
  const editable = normalizeProject({ ...snapshot, beadify: metadata });
  const plain = JSON.stringify(editable), plainBytes = utf8Bytes(plain);
  if (plainBytes > PROJECT_JSON_MAX_BYTES) {
    if (metadata.textAnalysis) return omitText('file-budget');
    throw new Error('Project grid, layers and settings exceed the 20 MiB import limit; reduce document size before exporting.');
  }
  const textStatus = metadata.textAnalysisOmission ? { textAnalysisOmitted: true } : {};
  if (!sourceRaster) return { json: plain, sourceRasterOmitted: !!metadata.sourceRasterOmission, ...textStatus, ...(metadata.sourceRasterOmission ? { reason: metadata.sourceRasterOmission } : {}) };
  const available = PROJECT_JSON_MAX_BYTES - plainBytes - utf8Bytes(',"sourceRaster":');
  const reason = options.omitSourceRaster ?? (boundedRasterBytes(sourceRaster, available) === null ? 'file-budget' : undefined);
  if (reason) {
    const json = JSON.stringify({ ...editable, beadify: { ...editable.beadify, sourceRasterOmission: reason } });
    if (utf8Bytes(json) > PROJECT_JSON_MAX_BYTES) throw new Error('Project grid, layers and settings exceed the 20 MiB import limit; reduce document size before exporting.');
    return { json, sourceRasterOmitted: true, ...textStatus, reason };
  }
  const complete = { ...editable, beadify: { ...editable.beadify!, sourceRaster } };
  validateMetadata(complete.beadify, complete.width, complete.height);
  return { json: JSON.stringify(complete), sourceRasterOmitted: false, ...textStatus };
}

/** Compact JSON remains compatible with existing project exporters. */
export function serializeProject(project: BeadProject): string { return serializeProjectWithStatus(project).json; }

function validateMetadata(input: unknown, width: number, height: number): Palette {
  const fail = (message: string): never => { throw new Error(`Invalid project: ${message}`); };
  const object = (value: unknown, allowed: string[], path: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
    const result = value as Record<string, unknown>;
    for (const key of Object.keys(result)) if (!allowed.includes(key)) fail(`${path}.${key} is unsupported`);
    return result;
  };
  const number = (value: unknown, min: number, max: number, path: string, integer = true) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(`invalid ${path}`);
  };
  const array = (value: unknown, min: number, max: number, path: string): unknown[] => {
    if (!Array.isArray(value) || value.length < min || value.length > max) fail(`invalid ${path}`);
    return value as unknown[];
  };
  const metadata = object(input, ['schemaVersion', 'paletteSnapshot', 'lastGeneration', 'generationSettings', 'constraints', 'sourceRaster', 'sourceRasterOmission', 'textAnalysis', 'textAnalysisOmission', 'textRetype', 'sceneAnalysis'], 'beadify');
  if (metadata.sceneAnalysis !== undefined) validateSceneAnalysis(metadata.sceneAnalysis);
  if (metadata.textRetype !== undefined) validateTextRetype(metadata.textRetype);
  if (metadata.textAnalysis !== undefined) validateTextAnalysis(metadata.textAnalysis);
  if (metadata.textAnalysisOmission !== undefined && metadata.textAnalysisOmission !== 'file-budget' && metadata.textAnalysisOmission !== 'storage-quota') fail('unsupported textAnalysisOmission');
  if (metadata.schemaVersion !== 1) fail('unsupported beadify schemaVersion');
  if (metadata.sourceRasterOmission !== undefined && metadata.sourceRasterOmission !== 'file-budget' && metadata.sourceRasterOmission !== 'storage-quota') fail('unsupported sourceRasterOmission');
  const palette = loadPalette(metadata.paletteSnapshot);
  const codes = new Set<string>();
  for (const color of palette.colors) {
    if (color.brand !== 'MARD' || codes.has(workspaceColorId(color))) fail('paletteSnapshot requires unique MARD codes');
    codes.add(workspaceColorId(color));
  }
  const methods = ['nearest', 'area', 'dominant', 'optimized', 'original'];
  const generation = object(metadata.lastGeneration, ['method', 'inputRevision', 'configHash'], 'lastGeneration');
  if (!methods.includes(generation.method as string)) fail('invalid lastGeneration.method');
  number(generation.inputRevision, 0, Number.MAX_SAFE_INTEGER, 'lastGeneration.inputRevision');
  if (generation.configHash !== null && (typeof generation.configHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(generation.configHash))) fail('invalid lastGeneration.configHash');
  const paletteIds = new Set(palette.colors.map(color => color.id));
  const checkColorIds = (value: unknown, path: string, min: number) => {
    const values = array(value, min, 512, path);
    if (new Set(values).size !== values.length || values.some(id => typeof id !== 'string' || !paletteIds.has(id))) fail(`invalid ${path} colors`);
  };
  if (metadata.generationSettings !== undefined) {
    const config = object(metadata.generationSettings, ['method', 'width', 'height', 'maxColors', 'style', 'preprocessing', 'sourceName', 'sourceHash', 'allowedColors', 'requiredColors', 'phase', 'optimization', 'sampling', 'sourceFeatures'], 'generationSettings');
    if (!methods.includes(config.method as string)) fail('invalid generationSettings.method');
    number(config.width, 1, 256, 'generationSettings.width'); number(config.height, 1, 256, 'generationSettings.height');
    number(config.maxColors, 1, 512, 'generationSettings.maxColors');
    if (config.sourceName !== undefined && (typeof config.sourceName !== 'string' || config.sourceName.length > 255)) fail('invalid sourceName');
    if (config.sourceHash !== undefined && (typeof config.sourceHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(config.sourceHash))) fail('invalid sourceHash');
    if (config.style !== undefined && !['accurate', 'clean', 'pixel-art', 'pixel-input'].includes(config.style as string)) fail('invalid generationSettings.style');
    if (config.allowedColors !== undefined) checkColorIds(config.allowedColors, 'allowedColors', 1);
    if (config.requiredColors !== undefined) checkColorIds(config.requiredColors, 'requiredColors', 0);
    if (config.phase !== undefined) array(config.phase, 2, 2, 'phase').forEach(value => number(value, -0.49, 0.49, 'phase', false));
    if (config.preprocessing !== undefined) {
      const prep = object(config.preprocessing, ['crop', 'background', 'tolerance', 'mask', 'smoothing'], 'preprocessing');
      if (prep.smoothing !== undefined && typeof prep.smoothing !== 'boolean') fail('invalid preprocessing.smoothing');
      if (prep.crop !== undefined) {
        const crop = array(prep.crop, 4, 4, 'crop');
        crop.forEach(value => number(value, 0, 4096, 'crop'));
        if ((crop[0] as number) >= (crop[2] as number) || (crop[1] as number) >= (crop[3] as number)) fail('invalid crop extent');
      }
      if (prep.background !== undefined && !['keep', 'edge'].includes(prep.background as string)) fail('invalid background');
      if (prep.tolerance !== undefined) number(prep.tolerance, 0, 255, 'tolerance');
      if (prep.mask !== undefined) array(prep.mask, 0, 4_194_304, 'mask').forEach(value => number(value, 0, 2, 'mask'));
    }
    if (config.optimization !== undefined) validateOptimizationOptions(config.optimization);
    if (config.sampling !== undefined) validateSamplingOptions(config.sampling);
    if (config.sourceFeatures !== undefined) validateSourceFeatures(config.sourceFeatures, undefined, undefined, paletteIds);
  }
  if (metadata.constraints !== undefined) validateCellConstraints(metadata.constraints, width, height, paletteIds);
  if (metadata.sourceRaster !== undefined) {
    validateSourceRaster(metadata.sourceRaster);
    if (metadata.sourceRaster.width !== width || metadata.sourceRaster.height !== height) fail('sourceRaster canvas mismatch');
    validateCellConstraints(metadata.sourceRaster.features, width, height, paletteIds);
    if (metadata.generationSettings) {
      const settings = metadata.generationSettings as Record<string, unknown>;
      if (settings.sourceHash !== undefined && settings.sourceHash !== metadata.sourceRaster.sourceHash) fail('sourceRaster source identity mismatch');
      if (settings.sourceFeatures !== undefined) validateSourceFeatures(settings.sourceFeatures, metadata.sourceRaster.geometry.sourceWidth, metadata.sourceRaster.geometry.sourceHeight, paletteIds);
    }
  }

  return palette;
}

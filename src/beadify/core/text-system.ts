import type { BeadPattern, ColorId, GenerationRequest, TextAnalysis } from '../contracts';
import { compareColorIds, linearToOklab, nearestColor, oklabDistance, srgb8ToLinear, type PreparedColor } from './color';
import { projectTextEvidence } from './text-analysis';
import { prepareImage } from './preprocess';
import { hashJson } from './hash';

export const TEXT_SYSTEM_VERSION = 'source-text-grid-v4';
const MIN_SUPPORT = .04;
type Sample = { coverage: number; lab: PreparedColor['oklab']; accepted: Set<string>; nearest: string; foreground: boolean; part: number };
export interface TextPart { foreground: boolean; hole: boolean; cells: number[]; footprint: number[]; coverage: Map<number, number>; accepted: Map<number, Set<string>>; mass: number; seed?: number; anchors: number[][]; baselineAnchors: boolean[]; baselineHole: boolean }
export interface TextRegionSystem { id: string; cells: number[]; cellSet: Set<number>; border: number[]; parts: TextPart[]; samples: Map<number, Sample[]>; baselineHealth: TextHealth }
export interface TextHealth { missing: number; fragments: number; bridges: number; lostHoles: number; lostAnchors: number }
export interface TextSystem { regions: TextRegionSystem[]; at: number[][]; allowed: Map<number, Set<string>>; baseline: (string | null)[]; width: number; height: number;
  writable: Set<number>; hash: string; diagnostics: { regionId: string; status: string; unexpressibleParts?: number; blockedCells?: number; unprojectedWitnesses?: number; limitedWitnessComponents?: number }[] }
const emptyHealth = (): TextHealth => ({ missing: 0, fragments: 0, bridges: 0, lostHoles: 0, lostAnchors: 0 });
function neighbors(i: number, width: number, height: number, diagonal: boolean): number[] {
  const result: number[] = [], x = i % width, y = Math.floor(i / width);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && (diagonal || Math.abs(dx) + Math.abs(dy) === 1) && x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) result.push((y + dy) * width + x + dx);
  return result;
}
function groups(indices: readonly number[], width: number, height: number, diagonal: boolean): number[][] {
  const remaining = new Set(indices), result: number[][] = [];
  for (const start of indices) {
    if (!remaining.delete(start)) continue;
    const group = [start];
    for (let j = 0; j < group.length; j++) for (const n of neighbors(group[j], width, height, diagonal)) if (remaining.delete(n)) group.push(n);
    result.push(group);
  }
  return result;
}
const matches = (part: TextPart, i: number, cells: readonly (string | null)[]) => cells[i] !== null && !!part.accepted.get(i)?.has(cells[i]!);
function exterior(region: TextRegionSystem, occupied: ReadonlySet<number>, width: number, height: number): Set<number> {
  const open = new Set(region.border.filter(i => !occupied.has(i))), queue = [...open];
  for (let q = 0; q < queue.length; q++) for (const n of neighbors(queue[q], width, height, false)) if (region.cellSet.has(n) && !occupied.has(n) && !open.has(n)) { open.add(n); queue.push(n); }
  return open;
}
/** Source-mask skeleton, before grid output is considered. It supplies only
 * original endpoint/junction witnesses, never font or language-model strokes. */
function sourceCriticalCells(pixels: readonly number[], width: number, height: number): number[] {
  const mask = new Set(pixels);
  const around = (i: number) => {
    const x = i % width, y = Math.floor(i / width);
    return [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]].map(([dx, dy]) => x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height && mask.has((y + dy) * width + x + dx) ? 1 : 0);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let phase = 0; phase < 2; phase++) {
      const remove: number[] = [];
      for (const i of mask) {
        const p = around(i), count = p.reduce<number>((sum, v) => sum + v, 0), transitions = p.reduce<number>((sum, v, j) => sum + Number(!v && p[(j + 1) % 8]), 0);
        if (count < 2 || count > 6 || transitions !== 1) continue;
        if (phase === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
        remove.push(i);
      }
      for (const i of remove) { mask.delete(i); changed = true; }
    }
  }
  return [...mask].filter(i => {
    const p = around(i);
    // Count branches with redundant diagonal links removed.
    let degree = p[0] + p[2] + p[4] + p[6];
    for (const j of [1, 3, 5, 7]) if (p[j] && !p[(j + 7) % 8] && !p[(j + 1) % 8]) degree++;
    return degree <= 1 || degree >= 3;
  });
}
export function textRegionHealth(region: TextRegionSystem, cells: readonly (string | null)[], width: number, height: number): TextHealth {
  const health = emptyHealth(), owners = new Map<number, Set<number>>();
  region.parts.forEach((part, pi) => {
    if (!part.foreground) return;
    const retained = part.cells.filter(i => matches(part, i, cells));
    if (!retained.length) health.missing++;
    const pieces = groups(retained, width, height, true); health.fragments += Math.max(0, pieces.length - 1);
    health.lostAnchors += part.anchors.filter(group => !group.some(i => matches(part, i, cells))).length;
    for (const i of retained) { const set = owners.get(i) ?? new Set<number>(); set.add(pi); owners.set(i, set); }
  });
  for (const component of groups([...owners.keys()], width, height, true)) {
    const identities = new Set(component.flatMap(i => [...owners.get(i)!])); health.bridges += Math.max(0, identities.size - 1);
  }
  const open = region.parts.some(p => p.hole) ? exterior(region, new Set(owners.keys()), width, height) : new Set<number>();
  for (const part of region.parts) if (part.hole) {
    if (part.seed === undefined || !matches(part, part.seed, cells)) { health.lostHoles++; continue; }
    if (open.has(part.seed)) health.lostHoles++;
  }
  return health;
}
export function textRegionCost(region: TextRegionSystem, cells: readonly (string | null)[], width: number, height: number, measuredHealth?: TextHealth): number {
  let presence = 0;
  for (const part of region.parts) {
    const recalled = part.cells.reduce((sum, i) => sum + (matches(part, i, cells) ? part.coverage.get(i)! : 0), 0) / Math.max(1e-12, part.mass);
    presence += Math.max(0, .75 - recalled) ** 2;
  }
  // Per-part rather than global area: a small dot or a narrow background channel
  // cannot disappear merely because a neighboring character is large.
  const health = measuredHealth ?? textRegionHealth(region, cells, width, height);
  return .12 * (presence + health.missing + health.fragments + health.bridges + health.lostHoles + health.lostAnchors) / Math.max(1, region.parts.length);
}
export function textWitnessesPreserved(region: TextRegionSystem, cells: readonly (string | null)[], width: number, height: number): boolean {
  for (const part of region.parts) if (part.anchors.some((group, i) => part.baselineAnchors[i] && !group.some(cell => matches(part, cell, cells)))) return false;
  if (region.parts.some(p => p.hole && p.baselineHole)) {
    const occupied = new Set(region.parts.filter(p => p.foreground).flatMap(p => p.cells.filter(i => matches(p, i, cells)))), open = exterior(region, occupied, width, height);
    for (const part of region.parts) if (part.hole && part.baselineHole && (part.seed === undefined || !matches(part, part.seed, cells) || open.has(part.seed))) return false;
  }
  return true;
}
export function textAdmissible(system: TextSystem, cells: readonly (string | null)[]): boolean {
  for (let i = 0; i < cells.length; i++) if (!system.writable.has(i) && cells[i] !== system.baseline[i]) return false;
  for (const [i, colors] of system.allowed) if (cells[i] !== system.baseline[i] && (cells[i] === null || !colors.has(cells[i]!))) return false;
  for (const region of system.regions) {
    if (!textWitnessesPreserved(region, cells, system.width, system.height)) return false;
    const health = textRegionHealth(region, cells, system.width, system.height);
    if ((Object.keys(health) as (keyof TextHealth)[]).some(k => health[k] > region.baselineHealth[k])) return false;
  }
  return true;
}

/** Components and negative spaces come solely from source masks. OCR strings,
 * provider labels and font libraries play no role in selecting actual colors. */
export function buildTextSystem(request: GenerationRequest, analysis: TextAnalysis, base: BeadPattern, colors: readonly PreparedColor[]): TextSystem {
  const locked = new Set((request.constraints ?? []).filter(c => c.kind === 'lock-color' || c.kind === 'lock-empty').flatMap(c => c.cellIndices));
  const projection = projectTextEvidence(analysis, request.image, { width: request.width, height: request.height, crop: request.preprocessing?.crop, phase: request.phase, lockedCells: [...locked] });
  const prepared = prepareImage(request.image, request.preprocessing).image;
  const [cropX, cropY] = request.preprocessing?.crop ?? [0, 0], sourceWidth = request.image.width, sourceHeight = request.image.height;
  const matrix = projection.geometry.sourceToGrid, scale = matrix[0];
  const regions: TextRegionSystem[] = [], diagnostics: TextSystem['diagnostics'] = [], at = Array.from({ length: base.cells.length }, () => [] as number[]);
  const allowed = new Map<number, Set<string>>(), writable = new Set<number>(), blocked = new Set<number>();
  const projectionWritable = new Set(projection.writableCells);
  const orderedRegions = analysis.regions.map(region => ({ region, key: hashJson({ polygon: region.polygon, evidence: analysis.evidence.filter(e => e.regionId === region.id && e.status === 'verified').map(e => [e.kind, e.runs]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0) }) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const { region } of orderedRegions) {
    const evidence = analysis.evidence.filter(e => e.regionId === region.id && e.status === 'verified');
    if (!evidence.length) continue;
    const mask = new Map<number, boolean>();
    for (const e of evidence) for (const [start, length] of e.runs) for (let i = start; i < start + length; i++) {
      const px = i % sourceWidth - cropX, py = Math.floor(i / sourceWidth) - cropY;
      if (px >= 0 && py >= 0 && px < prepared.width && py < prepared.height && prepared.data[(py * prepared.width + px) * 4 + 3] >= 128) mask.set(i, e.kind !== 'background');
    }
    const foreground = [...mask].filter(([, v]) => v).map(([i]) => i), background = [...mask].filter(([, v]) => !v).map(([i]) => i);
    if (!foreground.length || !background.length) { diagnostics.push({ regionId: region.id, status: 'UNKNOWN_MISSING_INK_OR_BACKGROUND' }); continue; }
    const components = [...groups(foreground, sourceWidth, sourceHeight, true).map(pixels => ({ pixels, foreground: true })), ...groups(background, sourceWidth, sourceHeight, false).map(pixels => ({ pixels, foreground: false }))];
    if (components.length > 64) { diagnostics.push({ regionId: region.id, status: 'TOO_MANY_SOURCE_COMPONENTS' }); continue; }
    const samples = new Map<number, Sample[]>(), parts: TextPart[] = [];
    let unprojectedWitnesses = 0, limitedWitnessComponents = 0;
    for (const [pi, component] of components.entries()) {
      const critical = component.foreground && component.pixels.length <= 131072 ? sourceCriticalCells(component.pixels, sourceWidth, sourceHeight) : [];
      if (component.foreground && (component.pixels.length > 131072 || critical.length > 128)) limitedWitnessComponents++;
      const bins = new Map<number, Map<string, { coverage: number; rgb: number[] }>>();
      for (const i of component.pixels) {
        const sx = i % sourceWidth, sy = Math.floor(i / sourceWidth), px = sx - cropX, py = sy - cropY;
        const alpha = prepared.data[(py * prepared.width + px) * 4 + 3] / 255;
        const x0 = sx * scale + matrix[2], y0 = sy * scale + matrix[5], x1 = x0 + scale, y1 = y0 + scale;
        const rgb = [request.image.data[i * 4], request.image.data[i * 4 + 1], request.image.data[i * 4 + 2]];
        const key = rgb.map(v => Math.floor(v / 32)).join(',');
        for (let y = Math.max(0, Math.floor(y0)); y < Math.min(request.height, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(request.width, Math.ceil(x1)); x++) {
          const index = y * request.width + x;
          if (base.cells[index] === null) continue;
          const weight = alpha * Math.max(0, Math.min(x1, x + 1) - Math.max(x0, x)) * Math.max(0, Math.min(y1, y + 1) - Math.max(y0, y));
          const cell = bins.get(index) ?? new Map(); const bin = cell.get(key) ?? { coverage: 0, rgb: [0, 0, 0] };
          bin.coverage += weight; rgb.forEach((v, k) => bin.rgb[k] += v * weight); cell.set(key, bin); bins.set(index, cell);
        }
      }
      const part: TextPart = { foreground: component.foreground, hole: !component.foreground && component.pixels.every(i => neighbors(i, sourceWidth, sourceHeight, false).length === 4 && neighbors(i, sourceWidth, sourceHeight, false).every(n => mask.has(n))), cells: [], footprint: [...bins.keys()], coverage: new Map(), accepted: new Map(), mass: 0, anchors: [], baselineAnchors: [], baselineHole: false };
      for (const [i, values] of bins) {
        const mass = [...values.values()].reduce((sum, v) => sum + v.coverage, 0);
        if (mass + 1e-12 < MIN_SUPPORT) continue;
        part.cells.push(i); part.coverage.set(i, mass); part.mass += mass;
        const accepted = new Set<string>();
        for (const value of [...values.values()].sort((a, b) => b.coverage - a.coverage).slice(0, 16)) {
          if (value.coverage < Math.min(MIN_SUPPORT, mass / 4)) continue;
          const rgb = value.rgb.map(v => v / value.coverage) as [number, number, number];
          const lab = linearToOklab(srgb8ToLinear(rgb)), nearest = nearestColor(lab, colors), best = oklabDistance(lab, colors.find(c => c.id === nearest)!.oklab);
          const matches = new Set(colors.filter(c => oklabDistance(lab, c.oklab) <= Math.max(.065, best + .015)).map(c => c.id));
          for (const id of matches) accepted.add(id);
          const row = samples.get(i) ?? []; row.push({ coverage: value.coverage, lab, accepted: matches, nearest, foreground: component.foreground, part: pi }); samples.set(i, row);
        }
        part.accepted.set(i, accepted);
      }
      part.cells.sort((a, b) => a - b);
      if (critical.length <= 128) for (const pixel of critical) {
        const gx = (pixel % sourceWidth + .5) * scale + matrix[2], gy = (Math.floor(pixel / sourceWidth) + .5) * scale + matrix[5];
        const support = part.cells.filter(i => Math.hypot(i % request.width + .5 - gx, Math.floor(i / request.width) + .5 - gy) <= .8);
        // No nearby source-supported grid cell means no anchor is fabricated.
        // The component's coverage/occupancy diagnostics remain in force.
        if (support.length) part.anchors.push(support); else unprojectedWitnesses++;
      }
      if (part.foreground && part.cells.length) {
        const xs = part.cells.map(i => i % request.width), ys = part.cells.map(i => Math.floor(i / request.width));
        const dx = Math.max(...xs) - Math.min(...xs), dy = Math.max(...ys) - Math.min(...ys);
        // Extent witnesses for elongated source components, not a claim that
        // all complex glyph endpoints have been skeletonized correctly.
        const axis = dy > 1.8 * Math.max(1, dx) ? ys : dx > 1.8 * Math.max(1, dy) ? xs : null;
        if (axis && !part.anchors.length) part.anchors = [Math.min(...axis), Math.max(...axis)].map(v => part.cells.filter((_, j) => axis[j] === v));
      }
      if (part.hole) part.seed = [...part.coverage].sort((a, b) => b[1] - a[1] || a[0] - b[0]).find(([, mass]) => mass >= .5)?.[0];
      parts.push(part);
    }
    const cells = [...samples.keys()].sort((a, b) => a - b), cellSet = new Set(cells);
    const bgColors = new Set([...samples.values()].flatMap(row => row.filter(s => !s.foreground && s.coverage >= .5).flatMap(s => [...s.accepted])));
    // A physical palette unable to separate source ink/background is not a font
    // reconstruction problem. Ambiguous swatches cannot prove a retained stroke.
    for (const part of parts) if (part.foreground) for (const accepted of part.accepted.values()) for (const id of bgColors) accepted.delete(id);
    for (const part of parts) {
      part.anchors = [...new Map(part.anchors.map(group => [group.join(','), group])).values()];
      part.baselineAnchors = part.anchors.map(group => group.some(i => matches(part, i, base.cells)));
    }
    if (cells.length > 4096 || cells.length + writable.size > 8192) {
      diagnostics.push({ regionId: region.id, status: 'TARGET_RESOURCE_LIMIT' }); continue;
    }
    const unexpressible = parts.filter(p => !p.cells.length || p.hole && p.seed === undefined || p.foreground && ![...p.accepted.values()].some(s => s.size));
    const frozen = new Set<number>();
    for (const part of unexpressible) for (const i of part.footprint) { frozen.add(i); for (const n of neighbors(i, request.width, request.height, true)) frozen.add(n); }
    for (const i of frozen) blocked.add(i);
    const activeParts = parts.filter(p => !unexpressible.includes(p));
    if (!activeParts.some(p => p.foreground) || !activeParts.some(p => !p.foreground)) { diagnostics.push({ regionId: region.id, status: 'UNEXPRESSIBLE_SOURCE_GEOMETRY', unexpressibleParts: unexpressible.length, blockedCells: frozen.size }); continue; }
    const system: TextRegionSystem = { id: region.id, cells, cellSet, samples, parts: activeParts, border: cells.filter(i => neighbors(i, request.width, request.height, false).length < 4 || neighbors(i, request.width, request.height, false).some(n => !cellSet.has(n))), baselineHealth: emptyHealth() };
    system.baselineHealth = textRegionHealth(system, base.cells, request.width, request.height);
    for (const part of activeParts) if (part.hole) part.baselineHole = textRegionHealth({ ...system, parts: activeParts.filter(p => p.foreground || p === part) }, base.cells, request.width, request.height).lostHoles === 0;
    const ri = regions.length; regions.push(system);
    for (const i of cells) {
      at[i].push(ri);
      const permitted = allowed.get(i) ?? new Set<string>();
      for (const sample of samples.get(i)!) for (const id of sample.accepted) permitted.add(id);
      allowed.set(i, permitted);
      if (!locked.has(i) && projectionWritable.has(i)) writable.add(i);
    }
    diagnostics.push({ regionId: region.id, status: unexpressible.length || unprojectedWitnesses || limitedWitnessComponents ? 'PARTIAL_SOURCE_GEOMETRY_READY' : 'SOURCE_GEOMETRY_READY', unexpressibleParts: unexpressible.length, blockedCells: frozen.size, unprojectedWitnesses, limitedWitnessComponents });
  }
  for (const i of blocked) writable.delete(i);
  // Fingerprint the integer palette inputs. Derived OKLab coordinates can differ
  // by a few floating-point bits across JS engines despite identical bead output.
  const paletteInputs = new Map(request.palette.colors.map(color => [color.id, color.srgb8]));
  return { regions, at, allowed, baseline: [...base.cells], width: request.width, height: request.height, writable, diagnostics,
    hash: hashJson({ version: TEXT_SYSTEM_VERSION, projection: projection.projectionHash, preprocessing: request.preprocessing ?? null, palette: colors.map(c => [c.id, paletteInputs.get(c.id)]), baseline: base.cells }) };
}

/** Whole ROI replacements include supported source background, so old fragments
 * can be removed. Each proposed color belongs to that cell's original pixels. */
export function textProposals(system: TextSystem, cells: readonly (ColorId | null)[], limit: number): (ColorId | null)[][] {
  const proposals: (ColorId | null)[][] = [];
  for (const region of system.regions) for (const threshold of [.5, .35, .2, .1]) {
    if (proposals.length >= limit) return proposals;
    const proposal = [...cells];
    for (const i of region.cells) {
      if (!system.writable.has(i)) continue;
      const samples = region.samples.get(i)!;
      const mass = samples.filter(s => s.foreground).reduce((sum, s) => sum + s.coverage, 0);
      const preferred = samples.filter(s => s.foreground === (mass >= threshold));
      const winner = (preferred.length ? preferred : samples).slice().sort((a, b) => b.coverage - a.coverage || compareColorIds(a.nearest, b.nearest))[0];
      if (winner) proposal[i] = winner.nearest;
    }
    if (proposal.some((c, i) => c !== cells[i])) proposals.push(proposal);
  }
  return proposals;
}

import type { ColorId, EnergyTerms, GenerationRequest, OptimizationReport, OptimizationRun } from '../contracts';
import { compareColorIds, nearestColor, oklabDistance, topKColors, type PreparedColor } from './color';
import type { TargetRaster } from './sampling';
import { buildSourceShapes, sourceShapeCost, sourceShapeProposals, type SourceShapeSystem } from './source-shape';
import { buildSourceColorFeatures, sourceColorProposals } from './source-color-priority';
import { textAdmissible, textRegionCost, textRegionHealth, textWitnessesPreserved, textProposals, type TextSystem } from './text-system';

export interface ConstraintConflict { code: string; message: string; cellIndices?: number[]; colorIds?: ColorId[] }
export class ConstraintConflictError extends Error {
  readonly code = 'INFEASIBLE_CONSTRAINTS';
  constructor(readonly conflicts: ConstraintConflict[]) {
    super(conflicts.map(conflict => conflict.message).join('; '));
    this.name = 'ConstraintConflictError';
  }
}

export interface EnergyWeights { color: number; smooth: number; edge: number; island: number; palette: number; feature: number; symmetry: number }
/** Provisional, explicit CPU presets. Quality gates require an independent image panel. */
export const OPTIMIZATION_PRESETS: Readonly<Record<'accurate' | 'clean' | 'pixel-art', Readonly<EnergyWeights>>> = Object.freeze({
  accurate: Object.freeze({ color: 1, smooth: 0.004, edge: 0.08, island: 0.002, palette: 0.0001, feature: 1, symmetry: 0 }),
  clean: Object.freeze({ color: 1, smooth: 0.02, edge: 0.18, island: 0.01, palette: 0.0001, feature: 1, symmetry: 0 }),
  'pixel-art': Object.freeze({ color: 1.5, smooth: 0.01, edge: 0.25, island: 0.004, palette: 0.0002, feature: 1, symmetry: 0 }),
});
interface Edge { p: number; q: number; contrast: number; reliability: number; smooth: number }
export interface Feature { indices: number[]; acceptedColors: Set<ColorId>; minCells: number; allowSingleton: boolean; strength: number; origin: 'manual' | 'source'; normalizer: number; sourceComponentId?: number; purpose?: 'color' | 'presence' }
export interface EnergyProblem {
  width: number; height: number; maxColors: number; target: TargetRaster;
  colors: PreparedColor[]; colorIndex: Map<ColorId, number>; costs: Float64Array[];
  candidates: ColorId[][]; locks: (ColorId | null | undefined)[]; required: Set<ColorId>;
  features: Feature[]; featureAt: number[][]; protection: Float64Array;
  sourceShapes: SourceShapeSystem;
  text?: TextSystem;
  edges: Edge[]; incidentEdges: number[][]; neighbors: number[][];
  symmetryPairs: [number, number][]; symmetryAt: number[][];
  weights: EnergyWeights; islandMaxSize: number; foreground: number; warnings: string[];
}
export interface EnergyState { cells: (ColorId | null)[]; refcounts: Map<ColorId, number>; featureCounts: number[]; shapeCosts: number[]; textCosts: number[] }
const EPSILON = 1e-12;
// Provisional modes-unary scale: cap excess squared source error at 0.25².
const SOURCE_MODE_DISTANCE_CAP = 0.25 ** 2;
// Same minimum reliable source coverage used by original-region projection.
// Smaller modes remain candidates and may be selected by explicit annotations.
const SOURCE_PRESERVATION_MIN_COVERAGE = 0.04;
function d2(a: PreparedColor['oklab'], b: PreparedColor['oklab']): number {
  return (a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2;
}
function neighborhood(index: number, width: number, height: number): number[] {
  const x = index % width, y = Math.floor(index / width), result: number[] = [];
  if (x > 0) result.push(index - 1);
  if (x + 1 < width) result.push(index + 1);
  if (y > 0) result.push(index - width);
  if (y + 1 < height) result.push(index + width);
  return result;
}

/** Build immutable input evidence, sparse candidates and exact normalized energy terms.
 * Manual protect raises fidelity and suppresses small-component loss; simplify does the
 * opposite. Feature colors and minority modes are injected beyond the nearest K.
 */
export function createEnergyProblem(request: GenerationRequest, targetInput: TargetRaster, colorsInput: readonly PreparedColor[], weightsOverride?: Partial<EnergyWeights>, text?: TextSystem): EnergyProblem {
  const colors = [...colorsInput].sort((a, b) => compareColorIds(a.id, b.id));
  const colorIndex = new Map(colors.map((color, index) => [color.id, index]));
  const target = targetInput.map(cell => cell ? { ...cell, modes: cell.modes.map(mode => ({ ...mode })) } : null);
  const count = target.length;
  const locks: EnergyProblem['locks'] = new Array(count).fill(undefined);
  const protection = new Float64Array(count), simplify = new Float64Array(count);
  const conflicts: ConstraintConflict[] = [], features: Feature[] = [], warnings: string[] = [];
  const required = new Set(request.requiredColors ?? []);
  for (const colorId of required) if (!colorIndex.has(colorId)) conflicts.push({ code: 'REQUIRED_NOT_ALLOWED', message: `Required color ${colorId} is outside allowedColors.`, colorIds: [colorId] });
  for (const constraint of request.constraints ?? []) {
    const { kind, cellIndices, colorId } = constraint;
    const strength = constraint.strength ?? 1;
    if (kind === 'lock-color' || kind === 'lock-empty') {
      const next = kind === 'lock-color' ? colorId! : null;
      if (next !== null && !colorIndex.has(next)) conflicts.push({ code: 'LOCK_NOT_ALLOWED', message: `Locked color ${next} is outside allowedColors.`, cellIndices, colorIds: [next] });
      for (const index of cellIndices) {
        if (locks[index] !== undefined && locks[index] !== next) conflicts.push({ code: 'OVERLAPPING_LOCKS', message: `Cell ${index} has incompatible locks.`, cellIndices: [index], colorIds: [locks[index], next].filter((id): id is string => typeof id === 'string') });
        locks[index] = next;
      }
    } else if (kind === 'protect') for (const index of cellIndices) protection[index] = Math.max(protection[index], strength);
    else if (kind === 'simplify') for (const index of cellIndices) simplify[index] = Math.max(simplify[index], strength);
    else if (strength > 0) {
      const acceptedColors = new Set(constraint.colorIds ?? [colorId!]);
      features.push({ indices: [...cellIndices], acceptedColors, minCells: constraint.minCells ?? 1, allowSingleton: constraint.allowSingleton ?? true, strength, origin: 'manual', normalizer: 1 });
      const unavailable = [...acceptedColors].filter(id => !colorIndex.has(id));
      if (unavailable.length) warnings.push(`Feature colors ${unavailable.join(', ')} are outside allowedColors and cannot be retained.`);
    }
  }
  const hardColors = new Set(required);
  for (let i = 0; i < count; i++) {
    const lock = locks[i];
    if (typeof lock === 'string') {
      hardColors.add(lock);
      const color = colors[colorIndex.get(lock)!];
      if (!target[i] && color) target[i] = { coverage: 1, mean: color.oklab, representative: color.oklab, modes: [{ color: color.oklab, weight: 1 }], edge: 0, importance: 1 };
    } else if (lock === null) target[i] = null;
  }
  if (hardColors.size > request.maxColors) conflicts.push({ code: 'COLOR_BUDGET', message: `${hardColors.size} required or locked colors exceed the budget ${request.maxColors}.`, colorIds: [...hardColors].sort(compareColorIds) });
  const lockedColors = new Set(locks.filter((id): id is string => typeof id === 'string'));
  const missingRequired = [...required].filter(id => !lockedColors.has(id)).sort(compareColorIds);
  const freeCount = target.filter((cell, index) => cell !== null && locks[index] === undefined).length;
  if (missingRequired.length > freeCount) conflicts.push({ code: 'REQUIRED_CAPACITY', message: `${missingRequired.length} required colors need distinct free foreground cells; only ${freeCount} are available.`, colorIds: missingRequired });
  if (conflicts.length) throw new ConstraintConflictError(conflicts);
  const preset = request.style === 'accurate' ? 'accurate' : request.style === 'pixel-art' || request.style === 'pixel-input' ? 'pixel-art' : 'clean';
  const weights = { ...OPTIMIZATION_PRESETS[preset], ...(request.optimization?.symmetry ? { symmetry: 0.08 } : {}), ...request.optimization?.weights, ...weightsOverride };
  // Manual regions keep their original normalization. Automatic component
  // conditions are normalized by foreground area independently, so detecting
  // more source components can never dilute an explicit user's feature.
  const manualCount = features.length, foreground = target.filter(Boolean).length;
  for (const feature of features) feature.normalizer = Math.max(1, manualCount);
  const manualSoft = new Set((request.constraints ?? []).filter(c => ['feature', 'protect', 'simplify'].includes(c.kind) && (c.strength ?? 1) > 0).flatMap(c => c.cellIndices));
  const groups = new Map<number, { id: number; kind: 'compact' | 'stroke'; span: number; cells: Map<number, { coverage: number; support: number; contrast: number; color: ColorId }> }>();
  if (request.sampling?.sourceEdges !== false && request.optimization?.sourceComponents !== false && request.style !== 'pixel-input' && weights.feature > 0) target.forEach((cell, index) => {
    if (!cell) return;
    const defaultUnary = cell.samplingStrategy ? (cell.samplingStrategy === 'modes' ? 'modes' : 'representative') : (request.style === 'accurate' || request.style === 'pixel-input' ? 'representative' : 'modes');
    if ((request.optimization?.unary ?? defaultUnary) !== 'modes') return;
    for (const mode of cell.modes) {
      if ((mode.sourceContrast ?? 0) < .18) continue;
      const color = nearestColor(mode.color, colors), colorLab = colors[colorIndex.get(color)!].oklab;
      const backdrop = colors[colorIndex.get(nearestColor(cell.representative, colors))!].oklab;
      if (d2(colorLab, backdrop) < ((mode.sourceContrast ?? 0) / 4) ** 2) continue;
      for (const component of mode.components ?? []) {
        if (component.kind === 'region') continue;
        if (component.support <= .5 || component.coverage + EPSILON < SOURCE_PRESERVATION_MIN_COVERAGE) continue;
        let group = groups.get(component.id);
        if (!group) { group = { id: component.id, kind: component.kind, span: component.span, cells: new Map() }; groups.set(component.id, group); }
        const previous = group.cells.get(index);
        if (!previous || component.coverage * component.support > previous.coverage * previous.support) group.cells.set(index, { coverage: component.coverage, support: component.support, contrast: mode.sourceContrast!, color });
      }
    }
  });
  // A stroke must have evidence in at least two target cells; a one-cell
  // diagonal texture fragment is not an automatic part-level condition.
  // Explicit soft controls take precedence across the entire source component.
  const automatic = [...groups.values()].filter(group => (group.kind === 'compact' || group.cells.size >= 2) && ![...group.cells.keys()].some(i => manualSoft.has(i))).map(group => {
    const indices = [...group.cells.keys()].sort((a, b) => a - b), members = [...group.cells.values()], mass = members.reduce((sum, c) => sum + c.coverage, 0);
    // Bounded source area times confidence times squared ORIGINAL contrast.
    // This soft deficit is tied to input evidence rather than bead frequency.
    const evidence = members.reduce((sum, c) => sum + c.coverage * c.support * c.contrast ** 2, 0) / Math.max(1, mass);
    return { indices, acceptedColors: new Set(members.map(c => c.color)), minCells: group.kind === 'compact' ? 1 : Math.min(indices.length, 8, Math.max(1, Math.floor(group.span))), allowSingleton: group.kind === 'compact', strength: evidence, origin: 'source' as const, normalizer: Math.max(1, foreground), sourceComponentId: group.id, purpose: 'presence' as const };
  }).sort((a, b) => b.strength - a.strength || a.sourceComponentId - b.sourceComponentId).slice(0, 64);
  features.push(...automatic);
  if (weights.feature > 0) features.push(...buildSourceColorFeatures(request, target, colors, manualSoft));
  const sourceShapes = weights.feature > 0 ? buildSourceShapes(request, target, colors, manualSoft) : { shapes: [], at: target.map(() => []) };
  const featureAt = Array.from({ length: count }, () => [] as number[]);
  features.forEach((feature, fi) => { for (const index of feature.indices) featureAt[index].push(fi); });
  const costs = target.map((cell, i) => {
    const row = new Float64Array(colors.length);
    if (!cell) return row;
    const fidelity = cell.importance * (1 + 4 * protection[i]) / (1 + 2 * simplify[i]);
    const defaultUnary = cell.samplingStrategy ? (cell.samplingStrategy === 'modes' ? 'modes' : 'representative') : (request.style === 'accurate' || request.style === 'pixel-input' ? 'representative' : 'modes');
    const useModes = (request.optimization?.unary ?? defaultUnary) === 'modes';
    // A known broad background component is not a tiny feature merely because
    // it is a minority within this grid cell. Preserve its ordinary color cost.
    const countedSourceComponents = new Set<number>();
    const sourceModes = request.sampling?.sourceEdges === false ? [] : cell.modes
      .filter(mode => !(mode.components?.length && mode.components.every(component => component.kind === 'region')) && !(mode.components?.length === 0 && (mode.boundarySupport ?? 0) > .5 && (mode.compactSupport ?? 0) <= .5) && (mode.structuralSupport ?? 0) >= 0.5 && (mode.sourceContrast ?? 0) >= 0.18 && (mode.sourceWeight ?? mode.weight) + EPSILON >= SOURCE_PRESERVATION_MIN_COVERAGE)
      .sort((a, b) => (b.sourceWeight ?? b.weight) * b.structuralSupport! - (a.sourceWeight ?? a.weight) * a.structuralSupport!)
      .filter(mode => {
        const ids = (mode.components ?? []).filter(component => component.kind !== 'region').map(component => component.id);
        // Raw bins and a canonical cross-bin mode can describe the SAME source
        // pixels. Keep their strongest whole-component observation once per
        // cell; the filtered mixture above still retains its original mass.
        if (ids.some(id => countedSourceComponents.has(id))) return false;
        for (const id of ids) countedSourceComponents.add(id);
        return true;
      })
      .map(mode => ({ mode, paletteFloor: Math.min(...colors.map(color => d2(mode.color, color.oklab))) }));
    for (let j = 0; j < colors.length; j++) {
      let distance = d2(cell.representative, colors[j].oklab);
      if (useModes) {
        // Fixed robust mixture: preserve dominant fidelity while accounting for
        // the full filtered mode mass. Truncation prevents one remote outlier
        // dominating the regional score. Only spatially coherent ORIGINAL modes
        // receive a minority opportunity cost; scattered speckles do not.
        const mixture = cell.modes.reduce((sum, mode) => sum + mode.weight * Math.min(0.04, d2(mode.color, colors[j].oklab)), 0);
        distance = 0.75 * distance + 0.25 * mixture;
        for (const { mode, paletteFloor } of sourceModes) {
          // Structural preservation uses excess error above the closest allowed
          // bead. Unavoidable source-to-palette error must not masquerade as
          // evidence that the feature should disappear on a physical palette.
          const excess = Math.max(0, d2(mode.color, colors[j].oklab) - paletteFloor);
          distance = Math.min(distance, excess + 0.025 * (1 - mode.structuralSupport!) + 0.001 * (1 - (mode.sourceWeight ?? mode.weight)));
        }
        // A discount alone gives an almost cost-free all-background solution.
        // Charge the source area actually lost when a coherent original mode
        // is ignored. The unit coefficient and fixed truncated excess squared OKLab
        // distance bound this evidence term; isolated texture has no support.
        distance += sourceModes.reduce((sum, { mode, paletteFloor }) => sum + (mode.sourceWeight ?? mode.weight) * mode.structuralSupport! * Math.min(SOURCE_MODE_DISTANCE_CAP, Math.max(0, d2(mode.color, colors[j].oklab) - paletteFloor)), 0);
      }
      // Confirmed manual features can use any matching real source mode,
      // including a sub-grid highlight; anchors still remain soft conditions.
      if (featureAt[i].some(fi => features[fi].origin === 'manual' && features[fi].acceptedColors.has(colors[j].id))) {
        for (const mode of cell.modes) if ((mode.sourceWeight ?? mode.weight) >= 0.02) {
          const modeDistance = d2(mode.color, colors[j].oklab);
          if (modeDistance < 0.01) distance = Math.min(distance, 0.025 + modeDistance);
        }
      }
      row[j] = fidelity * distance;
    }
    return row;
  });
  // Hard appearance is implemented by deterministic distinct anchors, not mere palette inclusion.
  for (const colorId of missingRequired) {
    let bestIndex = -1, best = Infinity;
    const ci = colorIndex.get(colorId)!;
    for (let i = 0; i < count; i++) if (target[i] && locks[i] === undefined && costs[i][ci] < best) { bestIndex = i; best = costs[i][ci]; }
    locks[bestIndex] = colorId;
  }
  const neighbors = Array.from({ length: count }, (_, i) => neighborhood(i, request.width, request.height));
  const initialNearest = target.map(cell => cell ? nearestColor(cell.representative, colors) : null);
  features.forEach((feature, fi) => {
    const availableColors = [...feature.acceptedColors].filter(id => colorIndex.has(id));
    const capacity = feature.indices.filter(index => target[index] && (locks[index] === undefined ? availableColors.length > 0 : feature.acceptedColors.has(locks[index]!))).length;
    if (capacity < feature.minCells) warnings.push(`Feature ${fi + 1} requests ${feature.minCells} cells but only ${capacity} compatible foreground cells are available.`);
  });
  const overlaps = new Set<string>();
  const sharedCells = featureAt.filter(at => at.length > 1).length;
  if (sharedCells) warnings.push(`Feature regions overlap in ${sharedCells} cells; their accepted-color counts are evaluated independently and their minimum counts may compete.`);
  // Bound detailed pair diagnostics independently of image area and feature
  // count. The aggregate overlap warning and final unmet count remain visible.
  overlapScan: for (const at of featureAt) for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) {
    overlaps.add(`${at[a]}:${at[b]}`);
    if (overlaps.size >= 128) break overlapScan;
  }
  for (const pair of overlaps) {
    const [a, b] = pair.split(':').map(Number), first = features[a], second = features[b];
    if (![...first.acceptedColors].some(id => second.acceptedColors.has(id))) {
      const unionCapacity = new Set([...first.indices, ...second.indices].filter(index => target[index] && (locks[index] === undefined || first.acceptedColors.has(locks[index]!) || second.acceptedColors.has(locks[index]!)))).size;
      if (first.minCells + second.minCells > unionCapacity) warnings.push(`Features ${a + 1} and ${b + 1} have incompatible minimum counts in their overlapping region.`);
    }
  }
  const candidates = target.map((cell, i) => {
    if (!cell) return [];
    if (typeof locks[i] === 'string') return [locks[i]! as string];
    const ids = new Set(topKColors(cell.representative, colors, 5).map(candidate => candidate.colorId));
    for (const mode of cell.modes) ids.add(nearestColor(mode.color, colors));
    for (const next of neighbors[i]) if (initialNearest[next] !== null) ids.add(initialNearest[next]!);
    for (const fi of featureAt[i]) for (const id of features[fi].acceptedColors) if (colorIndex.has(id)) ids.add(id);
    return [...ids].sort(compareColorIds);
  });
  const edges: Edge[] = [], incidentEdges = Array.from({ length: count }, () => [] as number[]);
  for (let p = 0; p < count; p++) if (target[p]) for (const q of neighbors[p]) if (q > p && target[q]) {
    const horizontal = q === p + 1 && p % request.width + 1 < request.width;
    const sourceEdges = request.sampling?.sourceEdges !== false;
    const contrast = sourceEdges ? (horizontal ? target[p]!.sourceRightContrast : target[p]!.sourceDownContrast) ?? Math.min(1, oklabDistance(target[p]!.representative, target[q]!.representative)) : 0;
    const reliability = sourceEdges ? (horizontal ? target[p]!.sourceRightReliability : target[p]!.sourceDownReliability) ?? 1 : 0;
    const index = edges.length;
    edges.push({ p, q, contrast, reliability, smooth: Math.exp(-8 * contrast * reliability) * (1 + (simplify[p] + simplify[q]) / 2) });
    incidentEdges[p].push(index); incidentEdges[q].push(index);
  }
  const symmetryPairs: [number, number][] = [], symmetryAt = Array.from({ length: count }, () => [] as number[]);
  if (weights.symmetry > 0) for (let p = 0; p < count; p++) {
    const q = Math.floor(p / request.width) * request.width + request.width - 1 - p % request.width;
    if (q > p && target[p] && target[q]) {
      const index = symmetryPairs.length; symmetryPairs.push([p, q]); symmetryAt[p].push(index); symmetryAt[q].push(index);
    }
  }
  // Input high-contrast cells, protected cells and manual features can be valid single beads.
  for (let i = 0; i < count; i++) if ((target[i]?.edge ?? 0) > 0.2 && (target[i]?.edgeReliability ?? 1) >= 0.5) protection[i] = Math.max(protection[i], 1);
  if (warnings.length > 20) warnings.splice(20, warnings.length - 20, `${warnings.length - 20} additional feature diagnostics omitted; all soft conditions are still scored and unmet counts are reported.`);
  if (text) for (const [i, allowed] of text.allowed) candidates[i] = [...new Set([...candidates[i], ...allowed])].sort(compareColorIds);
  return { width: request.width, height: request.height, maxColors: request.maxColors, target, colors, colorIndex, costs, candidates, locks, required, features, featureAt, sourceShapes, ...(text ? { text } : {}), protection, edges, incidentEdges, neighbors, symmetryPairs, symmetryAt, weights, islandMaxSize: request.optimization?.islandMaxSize ?? 4, foreground, warnings };
}

export function createEnergyState(problem: EnergyProblem, cellsInput: readonly (ColorId | null)[]): EnergyState {
  const cells = [...cellsInput], refcounts = new Map<ColorId, number>();
  for (const color of cells) if (color !== null) refcounts.set(color, (refcounts.get(color) ?? 0) + 1);
  const featureCounts = problem.features.map(feature => feature.indices.filter(i => cells[i] !== null && feature.acceptedColors.has(cells[i]!)).length);
  const shapeCosts = problem.sourceShapes.shapes.map(shape => sourceShapeCost(shape, cells, problem.width, problem.height));
  const textCosts = problem.text?.regions.map(r => textRegionCost(r, cells, problem.width, problem.height)) ?? [];
  return { cells, refcounts, featureCounts, shapeCosts, textCosts };
}
function componentProtection(problem: EnergyProblem, cells: readonly (ColorId | null)[], index: number): number {
  if (problem.text?.at[index].some(ri => problem.text!.regions[ri].parts.some(p => p.foreground && p.accepted.get(index)?.has(cells[index]!)))) return 1;
  if (problem.featureAt[index].some(fi => problem.features[fi].allowSingleton && problem.features[fi].acceptedColors.has(cells[index]!))) return 1;
  return Math.min(1, problem.protection[index]);
}
function componentPenalty(problem: EnergyProblem, cells: readonly (ColorId | null)[], group: readonly number[]): number {
  if (group.length > problem.islandMaxSize) return 0;
  const unprotected = group.reduce((sum, i) => sum + 1 - componentProtection(problem, cells, i), 0) / group.length;
  return (problem.islandMaxSize + 1 - group.length) / problem.islandMaxSize * unprotected;
}
/** Fresh bounded flood fills around a mutation. Components larger than the
 * threshold have zero penalty; the traversal can stop after threshold+1 cells.
 * Only COMPLETE small components are memoized, so a truncated large traversal
 * can never leave stale labels that turn its remainder into a false island. */
function affectedIslandPenalty(problem: EnergyProblem, cells: readonly (ColorId | null)[], seeds: readonly number[]): number {
  const counted = new Set<number>();
  let penalty = 0;
  for (const seed of seeds) {
    if (cells[seed] === null || counted.has(seed)) continue;
    const group = [seed], seen = new Set(group);
    for (let at = 0; at < group.length && group.length <= problem.islandMaxSize; at++) {
      for (const next of problem.neighbors[group[at]]) if (!seen.has(next) && cells[next] === cells[seed]) { seen.add(next); group.push(next); }
    }
    if (group.length > problem.islandMaxSize) continue;
    for (const i of group) counted.add(i);
    penalty += componentPenalty(problem, cells, group);
  }
  return penalty;
}
function monochromeComponents(problem: EnergyProblem, cells: readonly (ColorId | null)[]): number[][] {
  const groups: number[][] = [], seen = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) if (cells[i] !== null && !seen[i]) {
    const group = [i]; seen[i] = 1;
    for (let at = 0; at < group.length; at++) for (const next of problem.neighbors[group[at]]) if (!seen[next] && cells[next] === cells[i]) { seen[next] = 1; group.push(next); }
    groups.push(group);
  }
  return groups;
}
function edgeCosts(problem: EnergyProblem, edge: Edge, a: ColorId, b: ColorId): [number, number] {
  const contrast = Math.min(1, oklabDistance(problem.colors[problem.colorIndex.get(a)!].oklab, problem.colors[problem.colorIndex.get(b)!].oklab));
  return [a === b ? 0 : edge.smooth, edge.reliability * (contrast - edge.contrast) ** 2];
}
const featureCost = (count: number, feature: Feature) => feature.strength / feature.normalizer * (Math.max(0, feature.minCells - count) / Math.max(1, feature.minCells)) ** 2;

/** Full reference score rebuilds every same-color component. Single-cell
 * deltas and block proposals must agree with this independent traversal. */
export function evaluateEnergy(problem: EnergyProblem, cells: readonly (ColorId | null)[]): EnergyTerms {
  const terms: EnergyTerms = { color: 0, smooth: 0, edge: 0, island: 0, palette: 0, feature: 0, symmetry: 0, total: 0 };
  const used = new Set<ColorId>();
  for (let i = 0; i < cells.length; i++) if (cells[i] !== null) {
    used.add(cells[i]!);
    terms.color += problem.costs[i][problem.colorIndex.get(cells[i]!)!];
  }
  if (problem.weights.island !== 0) for (const group of monochromeComponents(problem, cells)) terms.island += componentPenalty(problem, cells, group);
  for (const edge of problem.edges) {
    const [smooth, contrast] = edgeCosts(problem, edge, cells[edge.p]!, cells[edge.q]!);
    terms.smooth += smooth; terms.edge += contrast;
  }
  for (const feature of problem.features) terms.feature += featureCost(feature.indices.filter(i => cells[i] !== null && feature.acceptedColors.has(cells[i]!)).length, feature);
  for (const shape of problem.sourceShapes.shapes) terms.feature += sourceShapeCost(shape, cells, problem.width, problem.height);
  if (problem.text) for (const region of problem.text.regions) terms.feature += textRegionCost(region, cells, problem.width, problem.height) / Math.max(1, problem.text.regions.length);
  for (const [p, q] of problem.symmetryPairs) if (cells[p] !== cells[q]) terms.symmetry++;
  terms.color *= problem.weights.color / Math.max(1, problem.foreground);
  terms.island *= problem.weights.island / Math.max(1, problem.foreground);
  terms.smooth *= problem.weights.smooth / Math.max(1, problem.edges.length);
  terms.edge *= problem.weights.edge / Math.max(1, problem.edges.length);
  terms.palette = problem.weights.palette * used.size / problem.maxColors;
  terms.feature *= problem.weights.feature;
  terms.symmetry *= problem.weights.symmetry / Math.max(1, problem.symmetryPairs.length);
  terms.total = terms.color + terms.smooth + terms.edge + terms.island + terms.palette + terms.feature + terms.symmetry;
  return terms;
}

export function isFeasible(problem: EnergyProblem, cells: readonly (ColorId | null)[]): boolean {
  if (cells.length !== problem.target.length) return false;
  const used = new Set<ColorId>();
  for (let i = 0; i < cells.length; i++) {
    const color = cells[i];
    if ((problem.target[i] === null) !== (color === null)) return false;
    if (problem.locks[i] !== undefined && color !== problem.locks[i]) return false;
    if (color !== null) { if (!problem.colorIndex.has(color)) return false; used.add(color); }
  }
  return used.size <= problem.maxColors && [...problem.required].every(id => used.has(id)) && (!problem.text || textAdmissible(problem.text, cells));
}

/** Exact single-cell delta, including final-reference removal and feature counts. */
export function energyDelta(problem: EnergyProblem, state: EnergyState, index: number, color: ColorId): number {
  const previous = state.cells[index];
  if (color === previous) return 0;
  if (previous === null || !problem.colorIndex.has(color)) return Infinity;
  if (problem.locks[index] !== undefined && problem.locks[index] !== color) return Infinity;
  if (problem.required.has(previous) && state.refcounts.get(previous) === 1) return Infinity;
  const enters = state.refcounts.has(color) ? 0 : 1, exits = state.refcounts.get(previous) === 1 ? 1 : 0;
  if (state.refcounts.size + enters - exits > problem.maxColors) return Infinity;
  if (problem.text && (!problem.text.writable.has(index) || color !== problem.text.baseline[index] && !problem.text.allowed.get(index)?.has(color))) return Infinity;
  const n = Math.max(1, problem.foreground), a = Math.max(1, problem.edges.length);
  let delta = problem.weights.color * (problem.costs[index][problem.colorIndex.get(color)!] - problem.costs[index][problem.colorIndex.get(previous)!]) / n;
  if (problem.text) for (const ri of problem.text.at[index]) {
    const region = problem.text.regions[ri];
    if (!region.parts.some(p => !!p.accepted.get(index)?.has(previous) !== !!p.accepted.get(index)?.has(color))) continue;
    state.cells[index] = color;
    const health = textRegionHealth(region, state.cells, problem.width, problem.height);
    const admissible = (Object.keys(health) as (keyof typeof health)[]).every(k => health[k] <= region.baselineHealth[k]) && textWitnessesPreserved(region, state.cells, problem.width, problem.height);
    if (admissible) delta += problem.weights.feature * (textRegionCost(region, state.cells, problem.width, problem.height, health) - state.textCosts[ri]) / problem.text.regions.length;
    state.cells[index] = previous;
    if (!admissible) return Infinity;
  }
  delta += problem.weights.palette * (enters - exits) / problem.maxColors;
  for (const ei of problem.incidentEdges[index]) {
    const edge = problem.edges[ei], other = state.cells[edge.p === index ? edge.q : edge.p]!;
    const before = edgeCosts(problem, edge, previous, other), after = edgeCosts(problem, edge, color, other);
    delta += (problem.weights.smooth * (after[0] - before[0]) + problem.weights.edge * (after[1] - before[1])) / a;
  }
  for (const fi of problem.featureAt[index]) {
    const feature = problem.features[fi], before = state.featureCounts[fi], after = before + Number(feature.acceptedColors.has(color)) - Number(feature.acceptedColors.has(previous));
    delta += problem.weights.feature * (featureCost(after, feature) - featureCost(before, feature));
  }
  if (problem.sourceShapes.at[index].length) {
    state.cells[index] = color;
    for (const si of problem.sourceShapes.at[index]) delta += problem.weights.feature * (sourceShapeCost(problem.sourceShapes.shapes[si], state.cells, problem.width, problem.height) - state.shapeCosts[si]);
    state.cells[index] = previous;
  }
  for (const si of problem.symmetryAt[index]) {
    const [p, q] = problem.symmetryPairs[si], other = state.cells[p === index ? q : p];
    delta += problem.weights.symmetry * (Number(color !== other) - Number(previous !== other)) / Math.max(1, problem.symmetryPairs.length);
  }
  if (problem.weights.island !== 0) {
    const affected = [index, ...problem.neighbors[index]];
    const before = affectedIslandPenalty(problem, state.cells, affected);
    state.cells[index] = color;
    const after = affectedIslandPenalty(problem, state.cells, affected);
    state.cells[index] = previous;
    delta += problem.weights.island * (after - before) / n;
  }
  return delta;
}
export function applyColorChange(problem: EnergyProblem, state: EnergyState, index: number, color: ColorId): void {
  const previous = state.cells[index]!;
  if (previous === color) return;
  const count = state.refcounts.get(previous)!;
  if (count === 1) state.refcounts.delete(previous); else state.refcounts.set(previous, count - 1);
  state.refcounts.set(color, (state.refcounts.get(color) ?? 0) + 1);
  for (const fi of problem.featureAt[index]) state.featureCounts[fi] += Number(problem.features[fi].acceptedColors.has(color)) - Number(problem.features[fi].acceptedColors.has(previous));
  state.cells[index] = color;
  for (const si of problem.sourceShapes.at[index]) state.shapeCosts[si] = sourceShapeCost(problem.sourceShapes.shapes[si], state.cells, problem.width, problem.height);
  if (problem.text) for (const ri of problem.text.at[index]) state.textCosts[ri] = textRegionCost(problem.text.regions[ri], state.cells, problem.width, problem.height);
}

/** Objective used by greedy palette selection includes soft feature opportunity,
 * without making every minority pixel a hard requirement. */
function unary(problem: EnergyProblem, index: number, colorId: ColorId): number {
  let value = problem.weights.color * problem.costs[index][problem.colorIndex.get(colorId)!] / Math.max(1, problem.foreground);
  for (const fi of problem.featureAt[index]) {
    const feature = problem.features[fi];
    if (feature.acceptedColors.has(colorId)) value -= problem.weights.feature * feature.strength / feature.normalizer / Math.max(1, feature.minCells);
  }
  return value;
}
function assignSubpalette(problem: EnergyProblem, selected: ReadonlySet<ColorId>): (ColorId | null)[] {
  const order = [...selected].sort(compareColorIds);
  return problem.target.map((cell, i) => {
    if (!cell) return null;
    if (typeof problem.locks[i] === 'string') return problem.locks[i] as string;
    let best = Infinity, winner = order[0];
    for (const id of order) {
      const cost = unary(problem, i, id);
      if (cost < best) { best = cost; winner = id; }
    }
    return winner;
  });
}
function selectSubpalette(problem: EnergyProblem): Set<ColorId> {
  const hard = new Set(problem.locks.filter((id): id is string => typeof id === 'string'));
  if (problem.colors.length <= problem.maxColors) return new Set(problem.colors.map(color => color.id));
  const unconstrained = assignSubpalette(problem, new Set(problem.colors.map(color => color.id)));
  const used = new Set(unconstrained.filter((id): id is string => id !== null));
  if (used.size <= problem.maxColors) return used;
  // Near a full palette, deterministic backward pruning avoids hundreds of
  // greedy scans. Both branches use fidelity gain, never raw color frequency.
  if (problem.maxColors > used.size / 2) {
    const selected = new Set(used);
    while (selected.size > problem.maxColors) {
      const assigned = assignSubpalette(problem, selected);
      let remove: string | undefined, loss = Infinity;
      for (const id of [...selected].sort(compareColorIds)) if (!hard.has(id)) {
        let candidateLoss = 0;
        for (let i = 0; i < assigned.length; i++) if (assigned[i] === id) {
          let alternative = Infinity;
          for (const other of selected) if (other !== id) alternative = Math.min(alternative, unary(problem, i, other));
          candidateLoss += alternative - unary(problem, i, id);
        }
        if (candidateLoss < loss) { loss = candidateLoss; remove = id; }
      }
      selected.delete(remove!);
    }
    return selected;
  }
  const selected = new Set(hard), best = new Float64Array(problem.target.length).fill(Infinity);
  for (let i = 0; i < best.length; i++) if (problem.target[i]) for (const id of selected) best[i] = Math.min(best[i], unary(problem, i, id));
  while (selected.size < problem.maxColors) {
    let winner: ColorId | undefined, highest = -Infinity;
    for (const color of problem.colors) if (!selected.has(color.id)) {
      let benefit = 0;
      for (let i = 0; i < best.length; i++) if (problem.target[i] && problem.locks[i] === undefined) {
        const cost = unary(problem, i, color.id);
        benefit += Number.isFinite(best[i]) ? Math.max(0, best[i] - cost) : -cost;
      }
      if (benefit > highest) { highest = benefit; winner = color.id; }
    }
    if (winner === undefined || (selected.size > 0 && highest <= EPSILON)) break;
    selected.add(winner);
    for (let i = 0; i < best.length; i++) if (problem.target[i]) best[i] = Math.min(best[i], unary(problem, i, winner));
  }
  return selected;
}

/** Alternate feasible starts explore coherent regions and seeded candidate/
 * palette choices. They never inherit an accepted run's energy baseline: every
 * run has its own descending trace, while the public trace is the global best. */
function restartAssignment(problem: EnergyProblem, basePalette: ReadonlySet<ColorId>, run: number, random: () => number): { selected: Set<ColorId>; cells: (ColorId | null)[]; initialization: string } {
  const selected = new Set(basePalette);
  const hard = new Set(problem.locks.filter((id): id is string => typeof id === 'string'));
  if (run > 0) {
    const outside = problem.colors.filter(color => !selected.has(color.id));
    const removable = [...selected].filter(id => !hard.has(id)).sort(compareColorIds);
    if (outside.length && (selected.size < problem.maxColors || removable.length)) {
      const sourceCandidates = new Set(problem.candidates.flat());
      const choices = outside.filter(color => sourceCandidates.has(color.id));
      const addition = (choices.length ? choices : outside)[Math.floor(random() * (choices.length || outside.length))].id;
      if (selected.size >= problem.maxColors) selected.delete(removable[Math.floor(random() * removable.length)]);
      selected.add(addition);
    }
  }
  const cells = assignSubpalette(problem, selected);
  if (run === 0) return { selected, cells, initialization: 'greedy-unary' };
  if (run % 2 === 1) {
    // Coarse spatial starts can cross a barrier that one-bead moves cannot.
    const offsetX = Math.floor(random() * 2), offsetY = Math.floor(random() * 2);
    for (let y = -offsetY; y < problem.height; y += 2) for (let x = -offsetX; x < problem.width; x += 2) {
      const group: number[] = [];
      for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
        const px = x + ox, py = y + oy, i = py * problem.width + px;
        if (px >= 0 && py >= 0 && px < problem.width && py < problem.height && cells[i] !== null && problem.locks[i] === undefined) group.push(i);
      }
      let winner: ColorId | undefined, cost = Infinity;
      for (const id of [...selected].sort(compareColorIds)) {
        const score = group.reduce((sum, i) => sum + unary(problem, i, id), 0);
        if (score < cost) { cost = score; winner = id; }
      }
      if (winner !== undefined) for (const i of group) cells[i] = winner;
    }
    return { selected, cells, initialization: 'seeded-coarse-regions' };
  }
  for (let i = 0; i < cells.length; i++) if (cells[i] !== null && problem.locks[i] === undefined && random() < 0.35) {
    const choices = [...new Set([...problem.candidates[i].filter(id => selected.has(id)), cells[i]!])]
      .sort((a, b) => unary(problem, i, a) - unary(problem, i, b) || compareColorIds(a, b)).slice(0, 3);
    cells[i] = choices[Math.floor(random() * choices.length)];
  }
  return { selected, cells, initialization: 'seeded-candidates' };
}

export function optimizePattern(request: GenerationRequest, target: TargetRaster, colors: readonly PreparedColor[], text?: TextSystem, onProgress?: (evaluations: number, maxEvaluations: number) => void): { cells: (ColorId | null)[]; report: OptimizationReport; warnings: string[]; problem: EnergyProblem } {
  const problem = createEnergyProblem(request, target, colors, undefined, text), basePalette = text ? new Set(text.baseline.filter((c): c is string => c !== null)) : selectSubpalette(problem);
  const iterationBudget = request.optimization?.iterations ?? 6, evaluationBudget = request.optimization?.maxEvaluations ?? 200_000;
  const seed = request.optimization?.seed ?? 0x5eed1234;
  let randomState = seed >>> 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x100000000; };
  const plannedRuns = problem.foreground === 0 || text ? 1 : Math.min(request.optimization?.restarts ?? 3, Math.max(1, iterationBudget), evaluationBudget);
  const runs: OptimizationRun[] = [];
  let bestCells: (ColorId | null)[] = [], bestEnergy = Infinity, initialEnergy = 0, bestRun = 0, iterations = 0, evaluations = 0;
  let lastReported = -256;
  const progress = (force = false) => {
    if (onProgress && (force || evaluations - lastReported >= 256)) { lastReported = evaluations; onProgress(evaluations, evaluationBudget); }
  };
  progress();
  const trace: number[] = [];
  const keepBest = (cells: readonly (ColorId | null)[], energy: number, run: number) => {
    if (energy < bestEnergy - EPSILON) { bestCells = [...cells]; bestEnergy = energy; bestRun = run; trace.push(energy); }
  };
  for (let run = 0; run < plannedRuns && evaluations < evaluationBudget; run++) {
    const remainingRuns = plannedRuns - run;
    const runIterationBudget = iterationBudget === 0 ? 0 : Math.max(1, Math.floor((iterationBudget - iterations) / remainingRuns));
    const runEvaluationLimit = evaluations + Math.max(1, Math.floor((evaluationBudget - evaluations) / remainingRuns));
    const { selected, cells, initialization } = text ? { selected: new Set(basePalette), cells: [...text.baseline], initialization: 'existing-pattern-text' } : restartAssignment(problem, basePalette, run, random);
    let state = createEnergyState(problem, cells);
    if (!isFeasible(problem, state.cells)) throw new Error('Internal optimizer initialization was infeasible');
    const runInitialEnergy = evaluateEnergy(problem, state.cells).total;
    evaluations++;
    const evaluationStart = evaluations - 1;
    if (run === 0) initialEnergy = runInitialEnergy;
    let energy = runInitialEnergy, runIterations = 0;
    const runTrace = [energy];
    keepBest(state.cells, energy, run);
    let stopReason: OptimizationReport['stopReason'] = problem.foreground === 0 ? 'empty' : 'iteration-budget';
    const record = () => {
      if (energy < runTrace[runTrace.length - 1] - EPSILON) runTrace.push(energy);
      keepBest(state.cells, energy, run);
    };
    const acceptFull = (proposal: (ColorId | null)[]): boolean => {
      if (!isFeasible(problem, proposal)) return false;
      const score = evaluateEnergy(problem, proposal).total;
      if (score >= energy - EPSILON) return false;
      state = createEnergyState(problem, proposal); energy = score; record(); return true;
    };
    for (let sweep = 0; sweep < runIterationBudget && problem.foreground > 0; sweep++) {
      if (evaluations >= runEvaluationLimit) { stopReason = 'evaluation-budget'; break; }
      let changed = false;
      // Seeded traversal order is fixed for the entire run, not wall-clock based.
      const order = Array.from({ length: state.cells.length }, (_, i) => i);
      if (run > 0) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (const i of order) if (state.cells[i] !== null && problem.locks[i] === undefined) {
        const candidates = new Set(problem.candidates[i].filter(id => selected.has(id)));
        candidates.add(state.cells[i]!);
        for (const next of problem.neighbors[i]) if (state.cells[next] !== null && selected.has(state.cells[next]!)) candidates.add(state.cells[next]!);
        let bestDelta = -EPSILON, winner: ColorId | undefined;
        for (const id of [...candidates].sort(compareColorIds)) {
          if (id === state.cells[i]) continue;
          if (evaluations >= runEvaluationLimit) { stopReason = 'evaluation-budget'; break; }
          evaluations++;
          progress();
          const delta = energyDelta(problem, state, i, id);
          if (delta < bestDelta) { bestDelta = delta; winner = id; }
        }
        if (winner !== undefined) {
          applyColorChange(problem, state, i, winner); energy += bestDelta; changed = true;
          if (state.refcounts.size > problem.maxColors) throw new Error('Internal optimizer color budget invariant failed');
        }
        if (stopReason === 'evaluation-budget') break;
      }
      iterations++; runIterations++;
      const checked = evaluateEnergy(problem, state.cells).total;
      if (!isFeasible(problem, state.cells) || checked > runTrace[runTrace.length - 1] + 1e-9 || Math.abs(checked - energy) > 1e-8) throw new Error('Internal optimizer energy/feasibility invariant failed');
      energy = checked; record();
      if (stopReason === 'evaluation-budget') break;
      const proposeText = (_problem: EnergyProblem, current: EnergyState, limit: number) => textProposals(text!, current.cells, limit);
      for (const propose of [...(text ? [proposeText] : []), sourceColorProposals, sourceShapeProposals]) {
        let proposals = 0, restart = true;
        while (restart && proposals < 12 && evaluations < runEvaluationLimit) {
          restart = false;
          for (const proposal of propose(problem, state, Math.min(12 - proposals, runEvaluationLimit - evaluations))) {
            evaluations++; proposals++;
            progress(true);
            if (acceptFull(proposal)) {
              selected.clear(); for (const id of state.refcounts.keys()) selected.add(id);
              changed = true; restart = true; break;
            }
          }
        }
      }
      // Rebuild after every accepted block. A merge/split invalidates the old
      // partition, even though full-score acceptance itself remains exact.
      let blockProposals = 0, restartComponents = true;
      while (restartComponents && blockProposals < 12 && evaluations < runEvaluationLimit) {
        restartComponents = false;
        for (const group of monochromeComponents(problem, state.cells)) {
          if (group.length > problem.islandMaxSize || group.some(i => problem.locks[i] !== undefined || componentProtection(problem, state.cells, i) >= 1)) continue;
          const replacements = new Set<ColorId>();
          for (const i of group) for (const next of problem.neighbors[i]) if (state.cells[next] !== null && state.cells[next] !== state.cells[i]) replacements.add(state.cells[next]!);
          for (const id of [...replacements].sort(compareColorIds)) {
            if (blockProposals >= 12 || evaluations >= runEvaluationLimit) break;
            blockProposals++; evaluations++;
            const proposal = [...state.cells]; for (const i of group) proposal[i] = id;
            if (acceptFull(proposal)) { changed = true; restartComponents = true; break; }
          }
          if (restartComponents || blockProposals >= 12 || evaluations >= runEvaluationLimit) break;
        }
      }
      if (sweep === 0) {
        const hard = new Set(problem.locks.filter((id): id is string => typeof id === 'string'));
        let deletions = 0;
        for (const removal of [...selected].filter(id => !hard.has(id)).sort(compareColorIds)) {
          if (selected.size <= 1 || deletions >= 6 || evaluations >= runEvaluationLimit) break;
          deletions++; evaluations++;
          const candidatePalette = new Set(selected); candidatePalette.delete(removal);
          if (acceptFull(assignSubpalette(problem, candidatePalette))) { selected.delete(removal); changed = true; }
        }
        const ranked = problem.colors.filter(color => !selected.has(color.id)).map(color => ({ id: color.id, gain: state.cells.reduce((sum, id, i) => id === null || problem.locks[i] !== undefined ? sum : sum + Math.max(0, unary(problem, i, id) - unary(problem, i, color.id)), 0) })).sort((a, b) => b.gain - a.gain || compareColorIds(a.id, b.id));
        let proposals = 0;
        for (const addition of ranked.slice(0, 4)) for (const removal of [...selected].filter(id => !hard.has(id)).sort(compareColorIds)) {
          if (proposals >= 12 || evaluations >= runEvaluationLimit) break;
          proposals++; evaluations++;
          const candidatePalette = new Set(selected); candidatePalette.delete(removal); candidatePalette.add(addition.id);
          if (acceptFull(assignSubpalette(problem, candidatePalette))) { selected.clear(); for (const id of candidatePalette) selected.add(id); changed = true; break; }
        }
      }
      if (evaluations >= runEvaluationLimit) { stopReason = 'evaluation-budget'; break; }
      if (!changed) { stopReason = 'converged'; break; }
    }
    if (problem.foreground > 0 && evaluations >= runEvaluationLimit && stopReason !== 'converged') stopReason = 'evaluation-budget';
    progress(true);
    runs.push({ initialization, initialEnergy: runInitialEnergy, finalEnergy: energy, evaluations: evaluations - evaluationStart, iterations: runIterations, stopReason, trace: runTrace });
    if (iterationBudget === 0) break;
  }
  const terms = evaluateEnergy(problem, bestCells);
  const unmetFeatures = problem.features.filter(feature => feature.indices.filter(i => bestCells[i] !== null && feature.acceptedColors.has(bestCells[i]!)).length < feature.minCells);
  const unmet = unmetFeatures.filter(feature => feature.origin === 'manual').length;
  const unmetAutomatic = unmetFeatures.length - unmet;
  const warnings = [...problem.warnings];
  if (unmet) warnings.push(`${unmet} soft feature anchor(s) could not be retained at their requested minimum counts under the selected colors and locks.`);
  if (unmetAutomatic) warnings.push(`${unmetAutomatic} automatic source component condition(s) remain below their soft minimum counts; inspect the source detail or add an explicit feature.`);
  const unmetShapes = problem.sourceShapes.shapes.filter(shape => sourceShapeCost(shape, bestCells, problem.width, problem.height) > EPSILON).length;
  if (unmetShapes) warnings.push(`${unmetShapes} automatic source shape condition(s) remain imperfect under the selected grid, colors and locks; inspect stroke continuity and enclosed interiors.`);
  warnings.push('Optimization presets are provisional; fixed-budget local search does not guarantee the global minimum.');
  const stopReason: OptimizationReport['stopReason'] = problem.foreground === 0 ? 'empty' : evaluations >= evaluationBudget ? 'evaluation-budget' : iterations >= iterationBudget ? 'iteration-budget' : runs.every(run => run.stopReason === 'converged') ? 'converged' : runs[runs.length - 1].stopReason;
  return { cells: bestCells, problem, warnings, report: { preset: request.style === 'accurate' ? 'accurate' : request.style === 'pixel-art' || request.style === 'pixel-input' ? 'pixel-art' : 'clean', initialEnergy, finalEnergy: terms.total, terms, iterations, evaluations, stopReason, trace, runs: runs as NonNullable<OptimizationReport['runs']>, seed, bestRun, hardConstraintsSatisfied: true } };
}

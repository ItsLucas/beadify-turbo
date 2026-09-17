import type { ColorId, GenerationRequest } from '../contracts';
import { compareColorIds, nearestColor, oklabDistance, type PreparedColor } from './color';
import type { TargetRaster } from './sampling';
import type { EnergyProblem, EnergyState } from './optimizer';

interface Member { index: number; coverage: number; support: number; contrast: number; color: ColorId; endpointMask: number }
export interface SourceShape {
  sourceComponentId: number;
  indices: number[];
  acceptedColors: Set<ColorId>;
  adjacency: number[][];
  endpoints: [number[], number[]];
  /** A source-supported geodesic, used for cross sections and bounded repairs. */
  path: number[];
  stations: number[][];
  closed: boolean;
  interior: { index: number; acceptedColors: Set<ColorId>; coverage: number }[];
  window: number[];
  windowBorder: Set<number>;
  widthLimit: number;
  strength: number;
  normalizer: number;
}
export interface SourceShapeSystem { shapes: SourceShape[]; at: number[][] }
const MAX_SHAPES = 64, MAX_VERTICES = 512, MIN_COVERAGE = .04;
const adjacent = (a: number, b: number, width: number) => Math.max(Math.abs(a % width - b % width), Math.abs(Math.floor(a / width) - Math.floor(b / width))) === 1;
function fourNeighbors(index: number, width: number, height: number): number[] {
  const x = index % width, y = Math.floor(index / width), result: number[] = [];
  if (x) result.push(index - 1); if (x + 1 < width) result.push(index + 1);
  if (y) result.push(index - width); if (y + 1 < height) result.push(index + width);
  return result;
}
function leaksToBorder(interior: readonly number[], barrier: ReadonlySet<number>, window: readonly number[], border: ReadonlySet<number>, width: number, height: number): boolean {
  const within = new Set(window), seen = new Set(interior), queue = [...interior];
  for (let q = 0; q < queue.length; q++) {
    if (border.has(queue[q])) return true;
    for (const next of fourNeighbors(queue[q], width, height)) if (within.has(next) && !barrier.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return false;
}

/** Only input-supported vertices can become a path. Cost prefers original
 * coverage, with a positive length term preventing loops or arbitrary detours. */
function shortestPath(members: Member[], adjacency: number[][], starts: number[], ends: Set<number>): number[] {
  const distances = members.map(() => Infinity), previous = members.map(() => -1), visited = new Uint8Array(members.length);
  for (const start of starts) distances[start] = 0;
  for (let step = 0; step < members.length; step++) {
    let best = -1;
    for (let i = 0; i < members.length; i++) if (!visited[i] && (best < 0 || distances[i] < distances[best])) best = i;
    if (best < 0 || !Number.isFinite(distances[best])) return [];
    if (ends.has(best)) { const path = [best]; while (previous[path[0]] >= 0) path.unshift(previous[path[0]]); return path; }
    visited[best] = 1;
    for (const next of adjacency[best]) {
      const cost = distances[best] + 1 + (1 - members[next].coverage * members[next].support);
      if (cost < distances[next]) { distances[next] = cost; previous[next] = best; }
    }
  }
  return [];
}

export function buildSourceShapes(request: GenerationRequest, target: TargetRaster, colors: readonly PreparedColor[], manualSoft: ReadonlySet<number>): SourceShapeSystem {
  const at = target.map(() => [] as number[]), shapes: SourceShape[] = [];
  if (request.optimization?.sourceShapes === false || request.sampling?.sourceEdges === false || request.style === 'pixel-input' || request.optimization?.weights?.feature === 0) return { shapes, at };
  const groups = new Map<number, { closed: boolean; thickness: number; cells: Map<number, Member> }>();
  target.forEach((cell, index) => {
    if (!cell) return;
    const defaultUnary = cell.samplingStrategy ? (cell.samplingStrategy === 'modes' ? 'modes' : 'representative') : request.style === 'accurate' ? 'representative' : 'modes';
    if ((request.optimization?.unary ?? defaultUnary) !== 'modes') return;
    for (const mode of cell.modes) for (const component of mode.components ?? []) {
      const contrast = component.contrast ?? mode.sourceContrast ?? 0;
      if (component.kind !== 'stroke' || component.support <= .5 || component.coverage + 1e-12 < MIN_COVERAGE || contrast < .18) continue;
      const color = nearestColor(mode.color, colors), colorLab = colors.find(candidate => candidate.id === color)!.oklab;
      // A dominant stroke vertex still connects its minority neighbors. Do not
      // drop it merely because its representative already matches the stroke.
      // A palette with no distinguishable swatch cannot express this topology.
      if (!colors.some(candidate => oklabDistance(colorLab, candidate.oklab) >= contrast / 4)) continue;
      let group = groups.get(component.id);
      if (!group) { group = { closed: false, thickness: component.thickness ?? .45, cells: new Map() }; groups.set(component.id, group); }
      group.closed ||= component.closed === true;
      group.thickness = Math.max(group.thickness, component.thickness ?? .45);
      const old = group.cells.get(index), endpointMask = (old?.endpointMask ?? 0) | (component.endpointMask ?? 0);
      // Canonical and raw modes can refer to the same component. Original area
      // must never be counted twice, nor grow when the palette changes.
      if (!old || component.coverage * component.support > old.coverage * old.support) group.cells.set(index, { index, coverage: component.coverage, support: component.support, contrast, color, endpointMask });
      else old.endpointMask = endpointMask;
    }
  });
  const foreground = Math.max(1, target.filter(Boolean).length);
  const eligible = [...groups.entries()].filter(([, group]) => group.cells.size >= 2 && group.cells.size <= MAX_VERTICES && (group.closed || [...group.cells.values()].reduce((mask, member) => mask | member.endpointMask, 0) === 3) && ![...group.cells.keys()].some(index => manualSoft.has(index))).map(([id, group]) => {
    const members = [...group.cells.values()], mass = members.reduce((sum, member) => sum + member.coverage, 0);
    const strength = members.reduce((sum, member) => sum + member.coverage * member.support * member.contrast ** 2, 0) / Math.max(1, mass);
    return { id, group, strength };
  }).sort((a, b) => b.strength - a.strength || a.id - b.id).slice(0, MAX_SHAPES);
  for (const { id, group, strength } of eligible) {
    const members = [...group.cells.values()].sort((a, b) => a.index - b.index);
    if (members.length < 2 || members.length > MAX_VERTICES || members.some(member => manualSoft.has(member.index))) continue;
    const indices = members.map(member => member.index), acceptedColors = new Set(members.map(member => member.color));
    const adjacency = members.map(member => members.flatMap((other, j) => adjacent(member.index, other.index, request.width) ? [j] : []));
    const endpoints: [number[], number[]] = [[], []];
    members.forEach((member, i) => { if (member.endpointMask & 1) endpoints[0].push(i); if (member.endpointMask & 2) endpoints[1].push(i); });
    // Older caches have no endpoint/loop proof. They retain presence scoring;
    // topology is not invented from the generated assignment or a bounding box.
    if (!group.closed && (!endpoints[0].length || !endpoints[1].length)) continue;
    let path = group.closed ? indices.map((_, i) => i) : shortestPath(members, adjacency, endpoints[0], new Set(endpoints[1]));
    if (path.length < 2) continue;
    const interior: SourceShape['interior'] = [], window: number[] = [], windowBorder = new Set<number>();
    if (group.closed) {
      const xs = indices.map(i => i % request.width), ys = indices.map(i => Math.floor(i / request.width));
      const x0 = Math.max(0, Math.min(...xs) - 1), x1 = Math.min(request.width - 1, Math.max(...xs) + 1), y0 = Math.max(0, Math.min(...ys) - 1), y1 = Math.min(request.height - 1, Math.max(...ys) + 1);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_VERTICES * 4) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * request.width + x; window.push(i); if (x === x0 || x === x1 || y === y0 || y === y1) windowBorder.add(i); }
      const boundaryLabs = colors.filter(color => acceptedColors.has(color.id)).map(color => color.oklab);
      const readInterior = (barrier: ReadonlySet<number>): SourceShape['interior'] => {
        const outside = new Set([...windowBorder].filter(index => !barrier.has(index))), queue = [...outside], within = new Set(window), result: SourceShape['interior'] = [];
        for (let q = 0; q < queue.length; q++) for (const next of fourNeighbors(queue[q], request.width, request.height)) if (within.has(next) && !barrier.has(next) && !outside.has(next)) { outside.add(next); queue.push(next); }
        for (const index of window) if (!barrier.has(index) && !outside.has(index) && target[index]) {
          const cell = target[index]!, mode = [...cell.modes].sort((a, b) => (b.sourceWeight ?? b.weight) - (a.sourceWeight ?? a.weight))[0];
          if (!mode || (mode.sourceWeight ?? mode.weight) < .5 || boundaryLabs.some(lab => oklabDistance(mode.color, lab) < .18)) continue;
          const distances = colors.map(color => ({ color, distance: oklabDistance(mode.color, color.oklab) })), nearest = Math.min(...distances.map(entry => entry.distance));
          const matches = distances.filter(({ color, distance }) => distance <= Math.max(.06, nearest + .02) && !acceptedColors.has(color.id) && boundaryLabs.every(lab => distance < .5 * oklabDistance(color.oklab, lab)));
          if (matches.length) result.push({ index, acceptedColors: new Set(matches.map(entry => entry.color.id)), coverage: (mode.sourceWeight ?? mode.weight) * cell.coverage });
        }
        return result;
      };
      interior.push(...readInterior(new Set(indices)));
      // A sub-resolution loop with no independently contrasting interior is not
      // evidence that a hole fits on this bead grid.
      if (!interior.length || window.some(i => manualSoft.has(i))) continue;
      // Thin only the original supported envelope. Removing its weakest area
      // first is deterministic and independent of palette/output labels. Every
      // removal must preserve a connected barrier enclosing ALL proven interior
      // cells. A single pass bounds work: removing more barrier can never repair
      // a leak that an earlier rejected removal would have opened.
      const loop = new Set(indices), interiorIndices = interior.map(member => member.index);
      for (const member of [...members].sort((a, b) => a.coverage * a.support - b.coverage * b.support || a.index - b.index)) {
        if (loop.size <= 4) break;
        loop.delete(member.index);
        const first = indices.findIndex(index => loop.has(index)), queue = [first], seen = new Set(queue);
        for (let q = 0; q < queue.length; q++) for (const next of adjacency[queue[q]]) if (loop.has(indices[next]) && !seen.has(next)) { seen.add(next); queue.push(next); }
        if (seen.size !== loop.size || leaksToBorder(interiorIndices, loop, window, windowBorder, request.width, request.height)) loop.add(member.index);
      }
      path = indices.flatMap((index, i) => loop.has(index) ? [i] : []);
      // A mostly-white cell may carry 4% of the original outline and therefore
      // belong to its envelope. Once the source-derived thin cycle encloses
      // that cell, retain its independently observed interior color too.
      interior.splice(0, interior.length, ...readInterior(loop));
    }
    // Assign each source-supported vertex to its nearest path cross section.
    // Alternative rows at a sampling boundary are valid; both need not be drawn.
    const stations = path.map(() => [] as number[]);
    members.forEach((member, i) => {
      let best = 0, distance = Infinity;
      path.forEach((pi, station) => { const p = members[pi].index; const d = (p % request.width - member.index % request.width) ** 2 + (Math.floor(p / request.width) - Math.floor(member.index / request.width)) ** 2; if (d < distance) { distance = d; best = station; } });
      stations[best].push(i);
    });
    shapes.push({ sourceComponentId: id, indices, acceptedColors, adjacency, endpoints, path, stations, closed: group.closed, interior, window, windowBorder, widthLimit: path.length * Math.max(1, group.thickness), strength, normalizer: foreground });
  }
  shapes.sort((a, b) => b.strength - a.strength || a.sourceComponentId - b.sourceComponentId);
  shapes.splice(MAX_SHAPES);
  shapes.forEach((shape, si) => { for (const index of new Set([...shape.indices, ...shape.interior.map(member => member.index)])) at[index].push(si); });
  return { shapes, at };
}

/** All losses are dimensionless, bounded source conditions. Counts alone cannot
 * reward a disconnected collection of beads or a filled eye. This routine is
 * shared by independent full scoring and exact affected-shape deltas. */
export function sourceShapeCost(shape: SourceShape, cells: readonly (ColorId | null)[], width: number, height: number): number {
  const selected = shape.indices.map(index => cells[index] !== null && shape.acceptedColors.has(cells[index]!));
  const count = selected.filter(Boolean).length, seen = new Uint8Array(selected.length);
  let largest = 0;
  for (let start = 0; start < selected.length; start++) if (selected[start] && !seen[start]) {
    const queue = [start]; seen[start] = 1;
    for (let q = 0; q < queue.length; q++) for (const next of shape.adjacency[queue[q]]) if (selected[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
    largest = Math.max(largest, queue.length);
  }
  const disconnected = count ? 1 - largest / count : 1;
  const missed = shape.stations.filter(station => !station.some(i => selected[i])).length / shape.stations.length;
  const thickness = Math.min(1, Math.max(0, count - shape.widthLimit) / Math.max(1, shape.widthLimit)) ** 2;
  let topology: number, interiorDeficit = 0;
  if (shape.closed) {
    const barrier = new Set(shape.indices.filter((_, i) => selected[i]));
    const leaks = leaksToBorder(shape.interior.map(member => member.index), barrier, shape.window, shape.windowBorder, width, height);
    const interiorMass = shape.interior.reduce((sum, member) => sum + member.coverage, 0);
    const lostMass = shape.interior.reduce((sum, member) => sum + (cells[member.index] === null || !member.acceptedColors.has(cells[member.index]!) ? member.coverage : 0), 0);
    interiorDeficit = (lostMass / Math.max(1e-12, interiorMass)) ** 2;
    topology = Number(leaks) / 2;
  } else topology = shape.endpoints.filter(endpoint => !endpoint.some(i => selected[i])).length / 2;
  // The paired interior is an independent source appearance condition, using
  // the same squared-deficit normalization as a source feature. Averaging it
  // with unrelated geometric checks would dilute that condition as more shape
  // checks are added. Boundary geometry retains its original coefficients.
  return shape.strength / shape.normalizer * ((disconnected + missed ** 2 + thickness + topology) / 4 + interiorDeficit);
}

/** Proposals use input paths and preserve every exterior cell. Palette/locks
 * remain hard checks in the optimizer; each yielded proposal consumes budget. */
export function* sourceShapeProposals(problem: EnergyProblem, state: EnergyState, maxProposals: number): Iterable<(ColorId | null)[]> {
  let proposed = 0;
  const withinBudget = (cells: readonly (ColorId | null)[]) => new Set(cells.filter(color => color !== null)).size <= problem.maxColors;
  // Check the final proposal's reference counts. A coherent replacement may
  // remove the final old-color use while introducing its accepted alternative.
  const choicesAt = (index: number, accepted: ReadonlySet<ColorId>) => [...accepted]
    .sort((a, b) => Number(state.refcounts.has(b)) - Number(state.refcounts.has(a)) || problem.costs[index][problem.colorIndex.get(a)!] - problem.costs[index][problem.colorIndex.get(b)!] || compareColorIds(a, b));
  for (const shape of problem.sourceShapes.shapes) {
    if (proposed >= maxProposals) return;
    const proposal = [...state.cells], path = new Set(shape.path.map(i => shape.indices[i]));
    for (const index of path) if (problem.locks[index] === undefined) {
      const choices = choicesAt(index, shape.acceptedColors);
      if (choices.length) proposal[index] = choices[0];
    }
    for (const member of shape.interior) if (problem.locks[member.index] === undefined) {
      const choices = choicesAt(member.index, member.acceptedColors);
      if (choices.length) proposal[member.index] = choices[0];
    }
    if (withinBudget(proposal) && proposal.some((color, i) => color !== state.cells[i])) { proposed++; yield proposal; }
    if (proposed >= maxProposals) continue;
    // A second proposal removes source-envelope thickness away from the path;
    // it cannot erase unrelated dark regions beyond this source component.
    const thin = [...proposal];
    for (const index of shape.indices) if (!path.has(index) && problem.locks[index] === undefined && shape.acceptedColors.has(thin[index]!)) {
      const choices = [...state.refcounts.keys()].filter(id => !shape.acceptedColors.has(id)).sort((a, b) => problem.costs[index][problem.colorIndex.get(a)!] - problem.costs[index][problem.colorIndex.get(b)!] || compareColorIds(a, b));
      if (choices.length) thin[index] = choices[0];
    }
    if (withinBudget(thin) && thin.some((color, i) => color !== proposal[i])) { proposed++; yield thin; }
  }
}

import type { ColorId, GenerationRequest } from '../contracts';
import { compareColorIds, type Oklab, type PreparedColor } from './color';
import type { TargetRaster } from './sampling';
import type { EnergyProblem, EnergyState } from './optimizer';

export interface SourceColorFeature {
  indices: number[];
  acceptedColors: Set<ColorId>;
  minCells: number;
  allowSingleton: boolean;
  strength: number;
  origin: 'source';
  normalizer: number;
  sourceComponentId: number;
  purpose: 'color';
}
const squaredDistance = (a: Oklab, b: Oklab) => (a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2;
const chroma = (color: Oklab) => Math.hypot(color.a, color.b);
const modesEnabled = (request: GenerationRequest, cell: NonNullable<TargetRaster[number]>) =>
  (request.optimization?.unary ?? (cell.samplingStrategy ? cell.samplingStrategy === 'modes' ? 'modes' : 'representative' : request.style === 'accurate' || request.style === 'pixel-input' ? 'representative' : 'modes')) === 'modes';

/** Filled colored source areas are distinct from thin-line minority discounts.
 * Their color may be locally dominant yet occupy little of the full picture.
 * Geometry/confidence and surrounding contrast come from the original pixels;
 * output frequencies and private annotations never define these conditions. */
export function buildSourceColorFeatures(request: GenerationRequest, target: TargetRaster, colors: readonly PreparedColor[], manualSoft: ReadonlySet<number>): SourceColorFeature[] {
  if (request.optimization?.sourceColors === false || request.optimization?.weights?.feature === 0 || request.sampling?.sourceEdges === false || request.style === 'pixel-input') return [];
  type Member = { coverage: number; support: number; contrast: number; color: Oklab };
  const groups = new Map<number, Map<number, Member>>();
  const foreground = Math.max(1, target.filter(Boolean).length);
  target.forEach((cell, index) => {
    if (!cell || !modesEnabled(request, cell)) return;
    for (const mode of cell.modes) for (const component of mode.components ?? []) {
      if (component.kind !== 'region' || component.support <= .5 || component.coverage + 1e-12 < .04 || (component.contrast ?? 0) < .06) continue;
      let group = groups.get(component.id);
      if (!group) { group = new Map(); groups.set(component.id, group); }
      // Filtered and source-only modes can expose the same source membership.
      // Keep its strongest observation rather than double-counting source area.
      const prior = group.get(index);
      if (!prior || component.coverage * component.support > prior.coverage * prior.support) group.set(index, { coverage: component.coverage, support: component.support, contrast: component.contrast!, color: mode.color });
    }
  });
  const features: SourceColorFeature[] = [];
  for (const [id, group] of groups) {
    if ([...group.keys()].some(index => manualSoft.has(index))) continue;
    const members = [...group.values()], mass = members.reduce((sum, member) => sum + member.coverage, 0);
    if (mass < .5 || mass > foreground / 4) continue;
    const mean: Oklab = { space: 'oklab', L: 0, a: 0, b: 0 };
    let confidence = 0, contrast = 0;
    for (const member of members) {
      mean.L += member.coverage * member.color.L / mass; mean.a += member.coverage * member.color.a / mass; mean.b += member.coverage * member.color.b / mass;
      confidence += member.coverage * member.support / mass; contrast += member.coverage * member.contrast / mass;
    }
    const sourceChroma = chroma(mean);
    if (sourceChroma < .035) continue;
    const distances = colors.map(color => ({ color, distance: Math.sqrt(squaredDistance(mean, color.oklab)) }));
    const nearest = Math.min(...distances.map(entry => entry.distance));
    const accepted = distances.filter(({ color, distance }) => {
      const candidateChroma = chroma(color.oklab);
      return distance <= Math.max(.06, nearest + .02) && candidateChroma >= .75 * sourceChroma
        && color.oklab.a * mean.a + color.oklab.b * mean.b >= .85 * candidateChroma * sourceChroma;
    }).sort((a, b) => a.distance - b.distance || compareColorIds(a.color.id, b.color.id)).slice(0, 12);
    // A grayscale-only allowed palette cannot be forced to invent a colored bead.
    if (!accepted.length) continue;
    features.push({ indices: [...group.keys()].sort((a, b) => a - b), acceptedColors: new Set(accepted.map(entry => entry.color.id)),
      minCells: Math.min(group.size, Math.max(1, Math.ceil(mass * .5))), allowSingleton: false,
      // Area / foreground remains invariant when the same source is rendered
      // at a larger grid. A fixed bead-count cap would weaken larger views.
      strength: mass * confidence * Math.min(.16, contrast ** 2 + sourceChroma ** 2),
      origin: 'source', normalizer: foreground, sourceComponentId: id, purpose: 'color' });
  }
  return features.sort((a, b) => b.strength - a.strength || a.sourceComponentId - b.sourceComponentId).slice(0, 64);
}

function coverageAt(problem: EnergyProblem, id: number, index: number): number {
  let coverage = 0;
  for (const mode of problem.target[index]?.modes ?? []) for (const component of mode.components ?? []) if (component.id === id && component.kind === 'region') coverage = Math.max(coverage, component.coverage);
  return coverage;
}

/** Coherent insertions can cross the one-bead palette-entry barrier. With a
 * full palette, try a similar-color merge before adding an accent. Hard locks
 * (including every exterior ROI cell) and already satisfied manual/colored
 * parts exclude donors; the optimizer still checks feasibility and FULL energy.
 * No proposal is accepted here and no objective coefficient is changed. */
export function* sourceColorProposals(problem: EnergyProblem, state: EnergyState, maxProposals: number): Generator<(ColorId | null)[]> {
  if (maxProposals <= 0 || problem.weights.feature === 0) return;
  const features = problem.features.filter(feature => feature.purpose === 'color');
  const protectedColors = new Set<ColorId>([...problem.required, ...problem.locks.filter((id): id is ColorId => typeof id === 'string')]);
  for (const feature of problem.features) {
    const matches = feature.indices.filter(index => state.cells[index] !== null && feature.acceptedColors.has(state.cells[index]!));
    if (feature.origin === 'manual' || feature.purpose === 'color' && matches.length >= feature.minCells) for (const index of matches) protectedColors.add(state.cells[index]!);
  }
  const occupied = new Map<ColorId, number[]>();
  state.cells.forEach((id, index) => { if (id !== null) { const indices = occupied.get(id) ?? []; indices.push(index); occupied.set(id, indices); } });
  let emitted = 0;
  for (const feature of features.sort((a, b) => b.strength - a.strength || (a.sourceComponentId ?? 0) - (b.sourceComponentId ?? 0))) {
    const count = feature.indices.filter(index => state.cells[index] !== null && feature.acceptedColors.has(state.cells[index]!)).length;
    if (count >= feature.minCells) continue;
    const free = feature.indices.filter(index => state.cells[index] !== null && problem.locks[index] === undefined && !feature.acceptedColors.has(state.cells[index]!));
    if (!free.length) continue;
    const candidates = [...feature.acceptedColors].filter(id => problem.colorIndex.has(id)).map(id => ({ id,
      gain: free.reduce((sum, i) => sum + problem.costs[i][problem.colorIndex.get(state.cells[i]!)!] - problem.costs[i][problem.colorIndex.get(id)!], 0) }))
      .sort((a, b) => b.gain - a.gain || compareColorIds(a.id, b.id)).slice(0, 2);
    for (const candidate of candidates) {
      const base = [...state.cells];
      if (!state.refcounts.has(candidate.id) && state.refcounts.size >= problem.maxColors) {
        let best: { remove: ColorId; replace: ColorId; cost: number } | undefined;
        for (const [remove, positions] of occupied) if (!protectedColors.has(remove) && !feature.acceptedColors.has(remove)) {
          const source = problem.colors[problem.colorIndex.get(remove)!].oklab;
          const replacements = [...occupied.keys()].filter(id => id !== remove).map(id => ({ id, color: problem.colors[problem.colorIndex.get(id)!].oklab }))
            .filter(other => squaredDistance(source, other.color) <= .02 && (chroma(source) < .035 || chroma(other.color) >= .5 * chroma(source)))
            .sort((a, b) => squaredDistance(source, a.color) - squaredDistance(source, b.color) || compareColorIds(a.id, b.id)).slice(0, 4);
          for (const { id: replace } of replacements) {
            let cost = 0;
            for (const i of positions) cost += problem.costs[i][problem.colorIndex.get(replace)!] - problem.costs[i][problem.colorIndex.get(remove)!];
            if (!best || cost < best.cost - 1e-12 || Math.abs(cost - best.cost) <= 1e-12 && compareColorIds(remove + '/' + replace, best.remove + '/' + best.replace) < 0) best = { remove, replace, cost };
          }
        }
        if (!best) continue;
        for (let i = 0; i < base.length; i++) if (base[i] === best.remove) base[i] = best.replace;
      }
      const ranked = free.map(index => ({ index, coverage: coverageAt(problem, feature.sourceComponentId!, index), gain: problem.costs[index][problem.colorIndex.get(base[index]!)!] - problem.costs[index][problem.colorIndex.get(candidate.id)!] }))
        .sort((a, b) => Number(b.coverage >= .5) - Number(a.coverage >= .5) || b.gain - a.gain || b.coverage - a.coverage || a.index - b.index);
      const minimum = Math.min(ranked.length, Math.max(1, feature.minCells - count));
      const core = ranked.filter(entry => entry.coverage >= .5 || entry.gain > 0).length;
      for (const size of [...new Set([minimum, Math.max(minimum, core)])]) {
        const proposal = [...base];
        for (const { index } of ranked.slice(0, size)) proposal[index] = candidate.id;
        yield proposal;
        if (++emitted >= maxProposals) return;
      }
    }
  }
}

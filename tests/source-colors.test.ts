import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationRequest, Palette, Srgb8 } from '../src/beadify/contracts';
import { createEnergyProblem, createEnergyState, evaluateEnergy, isFeasible, linearToOklab, prepareColors, srgb8ToLinear } from '../src/beadify/core';
import { buildSourceColorFeatures, sourceColorProposals } from '../src/beadify/core/source-color-priority';
import type { TargetRaster } from '../src/beadify/core/sampling';

const palette: Palette = { id: 'source-color-test', version: '1', source: 'Self-authored numerical color-region fixture', license: 'CC0-1.0', approximate: false,
  colors: ([['gray1', [180, 180, 180]], ['gray2', [170, 172, 177]], ['pink', [238, 179, 182]], ['red', [210, 45, 50]]] as [string, Srgb8][]).map(([id, srgb8]) => ({ id, code: id, brand: 'test', series: 'solid', srgb8 })) };
const colors = prepareColors(palette.colors);
function fixture(): { request: GenerationRequest; target: TargetRaster; indices: number[] } {
  const width = 16, height = 12, indices: number[] = [], bytes: number[] = [];
  const target: TargetRaster = Array.from({ length: width * height }, (_, i) => {
    const inside = i % width >= 6 && i % width < 10 && Math.floor(i / width) >= 4 && Math.floor(i / width) < 8;
    const color = palette.colors.find(color => color.id === (inside ? 'pink' : i % width < 8 ? 'gray1' : 'gray2'))!;
    bytes.push(...color.srgb8, 255); if (inside) indices.push(i);
    const lab = linearToOklab(srgb8ToLinear(color.srgb8));
    return { coverage: 1, mean: lab, representative: lab, edge: 0, importance: 1, samplingStrategy: 'modes',
      modes: [{ color: lab, weight: 1, sourceWeight: 1, structuralSupport: inside ? .9 : 1, sourceContrast: 0,
        ...(inside ? { components: [{ id: 7, kind: 'region' as const, span: 4, coverage: 1, support: .9, contrast: .23 }] } : {}) }] };
  });
  return { request: { schemaVersion: 1, revision: 0, width, height, image: { width, height, data: bytes }, palette, maxColors: 2, method: 'optimized', style: 'clean' }, target, indices };
}

test('source filled-color priority has source-only hue acceptance and no duplicate mass', () => {
  const { request, target, indices } = fixture(), before = JSON.stringify(target);
  const features = buildSourceColorFeatures(request, target, colors, new Set());
  assert.equal(features.length, 1); assert.equal(features[0].minCells, 8);
  assert.deepEqual([...features[0].acceptedColors], ['pink']);
  assert.deepEqual(features[0].indices, indices);
  assert.equal(JSON.stringify(target), before, 'source evidence is immutable');
  const duplicated = target.map(cell => cell && ({ ...cell, modes: [...cell.modes.map(mode => ({ ...mode, weight: .5 })), ...cell.modes.map(mode => ({ ...mode, weight: .5 }))] }));
  assert.deepEqual(buildSourceColorFeatures(request, duplicated, colors, new Set()), features);
  assert.equal(buildSourceColorFeatures(request, target, colors.filter(color => color.id.startsWith('gray')), new Set()).length, 0);
});

test('color priority yields to manual controls and explicit feature ablations', () => {
  const { request, target, indices } = fixture();
  assert.equal(buildSourceColorFeatures(request, target, colors, new Set([indices[0]])).length, 0);
  for (const change of [{ optimization: { sourceColors: false } }, { optimization: { weights: { feature: 0 } } }, { optimization: { unary: 'representative' as const } }, { sampling: { sourceEdges: false } }, { style: 'pixel-input' as const }]) {
    assert.equal(buildSourceColorFeatures({ ...request, ...change }, target, colors, new Set()).length, 0);
  }
  const gray = colors[0].oklab;
  const neutral = target.map(cell => cell && ({ ...cell, modes: cell.modes.map(mode => ({ ...mode, color: gray })) }));
  assert.equal(buildSourceColorFeatures(request, neutral, colors, new Set()).length, 0, 'neutral texture is not a chromatic accent');
});

test('the same colored region keeps its normalized priority when source and bead grid scale together', () => {
  const { request, target, indices } = fixture(), original = buildSourceColorFeatures(request, target, colors, new Set())[0];
  const width = request.width * 2, height = request.height * 2;
  const enlarged: TargetRaster = Array.from({ length: width * height }, (_, i) => {
    const parent = Math.floor(i / width / 2) * request.width + Math.floor(i % width / 2), cell = structuredClone(target[parent]);
    for (const mode of cell?.modes ?? []) for (const component of mode.components ?? []) component.span *= 2;
    return cell;
  });
  const scaled = buildSourceColorFeatures({ ...request, width, height }, enlarged, colors, new Set())[0];
  assert.equal(scaled.indices.length, indices.length * 4);
  assert.equal(scaled.minCells, original.minCells * 4);
  assert.ok(Math.abs(scaled.strength / scaled.normalizer - original.strength / original.normalizer) < 1e-12);
});

test('an available palette slot supports coherent source recoloring with no exterior edits', () => {
  const { request, target, indices } = fixture();
  const problem = createEnergyProblem(request, target, colors), state = createEnergyState(problem, Array(target.length).fill('gray1'));
  const proposals = [...sourceColorProposals(problem, state, 4)];
  assert.ok(proposals.length > 0 && proposals.length <= 4);
  const allowed = new Set(indices), before = evaluateEnergy(problem, state.cells).total;
  for (const proposal of proposals) {
    assert.ok(isFeasible(problem, proposal));
    proposal.forEach((id, i) => { if (!allowed.has(i)) assert.equal(id, state.cells[i]); });
    assert.ok(indices.filter(i => proposal[i] === 'pink').length >= 8);
  }
  assert.ok(proposals.some(proposal => evaluateEnergy(problem, proposal).total < before));
  assert.ok(state.cells.every(id => id === 'gray1'), 'generating proposals must not mutate live labels');
});

test('a full palette can merge close grays for an accent, but required and locked colors cannot be removed', () => {
  const { request, target, indices } = fixture();
  const labels = target.map((_, i) => i % request.width < 8 ? 'gray1' : 'gray2');
  const problem = createEnergyProblem(request, target, colors), state = createEnergyState(problem, labels);
  const proposals = [...sourceColorProposals(problem, state, 4)];
  assert.ok(proposals.some(proposal => proposal.includes('pink')));
  for (const proposal of proposals) { assert.ok(isFeasible(problem, proposal)); assert.ok(new Set(proposal).size <= 2); }
  const locked = createEnergyProblem({ ...request, constraints: [{ kind: 'lock-color', colorId: 'gray1', cellIndices: [0] }, { kind: 'lock-color', colorId: 'gray2', cellIndices: [request.width - 1] }] }, target, colors);
  assert.deepEqual([...sourceColorProposals(locked, createEnergyState(locked, labels), 4)], []);
  const required = createEnergyProblem({ ...request, requiredColors: ['gray1', 'gray2'] }, target, colors);
  assert.deepEqual([...sourceColorProposals(required, createEnergyState(required, labels), 4)], []);
  assert.equal(indices.length, 16);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationRequest, Palette, Srgb8 } from '../src/beadify/contracts/index';
import { applyColorChange, ConstraintConflictError, createEnergyProblem, createEnergyState, createSourceRaster, energyDelta, evaluateEnergy, generatePattern, buildBom, isFeasible, loadPalette, prepareColors, linearToOklab, srgb8ToLinear, oklabDistance, optimizePattern, sampleStructuredImage, toJsonRequest, validatePattern, validateRequest } from '../src/beadify/core/index';
import { patternGeometry } from '../src/beadify/core/validation';
import { inspectConnectivity } from '../src/beadify/core/grid';
import { createDetailFixtures, projectedFeatureCoverage } from '../benchmark/detail-fixtures';
import { basicPalette, completePalette } from '../src/palette';
import { workspacePalette } from '../src/beadify/adapter';
import { createG2Fixtures, acceptableG2Colors, projectG2Mask } from '../benchmark/g2-fixtures';
import { sourceShapeCost, sourceShapeProposals } from '../src/beadify/core/source-shape';

const palette = (entries: [string, Srgb8][]): Palette => loadPalette({ id: 'test', version: '1', source: 'Original numeric fixtures', license: 'CC0-1.0', approximate: false, colors: entries.map(([id, srgb8]) => ({ id, code: id, brand: 'test', series: 'test', srgb8 })) });
const BW = palette([['B', [0, 0, 0]], ['W', [255, 255, 255]]]);
const request = (pixels: Srgb8[], width: number, extra: Partial<GenerationRequest> = {}): GenerationRequest => ({ schemaVersion: 1, revision: 0, image: { width, height: pixels.length / width, data: pixels.flatMap(color => [...color, 255]) }, width, height: pixels.length / width, palette: BW, maxColors: 2, method: 'optimized', ...extra });
const gray = (v: number): Srgb8 => [v, v, v];
const makeProblem = (req: GenerationRequest, override = {}) => createEnergyProblem(req, sampleStructuredImage(req.image, req.width, req.height, patternGeometry(req.image.width, req.image.height, req.width, req.height), req.style), prepareColors(req.palette.colors.filter(color => !req.allowedColors || req.allowedColors.includes(color.id))), override);
const close = (actual: number, expected: number, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('2x2 full score agrees with independent hand energy and exhaustive optimum on all assignments', () => {
  const req = request([gray(0), gray(255), gray(0), gray(255)], 2, { style: 'accurate' });
  const target = sampleStructuredImage(req.image, 2, 2, patternGeometry(2, 2, 2, 2), req.style);
  target.forEach(cell => { if (cell) cell.importance = 1; });
  const problem = createEnergyProblem(req, target, prepareColors(req.palette.colors), { color: 1, smooth: 0, edge: 0, island: 0, palette: 0, feature: 0, symmetry: 0 });
  let minimum = Infinity, minimizer: string[] = [];
  for (let mask = 0; mask < 16; mask++) {
    const cells = Array.from({ length: 4 }, (_, i) => mask & (1 << i) ? 'W' : 'B');
    const independent = cells.reduce((sum, id, i) => sum + (id === (i % 2 ? 'W' : 'B') ? 0 : 1), 0) / 4;
    const score = evaluateEnergy(problem, cells).total;
    close(score, independent, 1e-7);
    if (score < minimum) { minimum = score; minimizer = cells; }
  }
  assert.deepEqual(minimizer, ['B', 'W', 'B', 'W']);
  assert.deepEqual(generatePattern(req).cells, minimizer);
  close(minimum, 0);
});

test('every randomized incremental delta matches full scoring, refcounts and overlapping features', () => {
  const p = palette([['A', gray(60)], ['B', gray(105)], ['C', gray(150)]]);
  const req = request(Array.from({ length: 9 }, (_, i) => gray(70 + i * 8)), 3, { palette: p, maxColors: 3, optimization: { symmetry: true }, constraints: [{ kind: 'feature', cellIndices: [0, 1, 4], colorIds: ['A', 'B'], minCells: 2, strength: 1.5 }, { kind: 'feature', cellIndices: [1, 4, 8], colorIds: ['B', 'C'], minCells: 3, allowSingleton: false, strength: 0.5 }, { kind: 'protect', cellIndices: [3], strength: 0.3 }, { kind: 'simplify', cellIndices: [6], strength: 2 }] });
  const problem = makeProblem(req);
  let seed = 918273;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const state = createEnergyState(problem, Array.from({ length: 9 }, (_, i) => ['A', 'B', 'C'][i % 3]));
  for (let round = 0; round < 600; round++) {
    const index = random() % 9, color = ['A', 'B', 'C'][random() % 3];
    const before = evaluateEnergy(problem, state.cells).total;
    const delta = energyDelta(problem, state, index, color);
    const proposal = [...state.cells]; proposal[index] = color;
    close(delta, evaluateEnergy(problem, proposal).total - before);
    applyColorChange(problem, state, index, color);
    const rebuilt = createEnergyState(problem, state.cells);
    assert.deepEqual([...state.refcounts].sort(), [...rebuilt.refcounts].sort());
    assert.deepEqual(state.featureCounts, rebuilt.featureCounts);
  }
});

test('palette delta handles final reference removal, color entry and hard budget', () => {
  const p = palette([['A', gray(10)], ['B', gray(80)], ['C', gray(180)]]);
  const problem = makeProblem(request([gray(10), gray(10), gray(80)], 3, { palette: p, maxColors: 2 }), { color: 0, smooth: 0, edge: 0, island: 0, feature: 0, symmetry: 0, palette: 1 });
  const state = createEnergyState(problem, ['A', 'A', 'B']);
  close(energyDelta(problem, state, 2, 'A'), -0.5);
  assert.equal(energyDelta(problem, state, 0, 'C'), Infinity);
  close(energyDelta(problem, state, 2, 'C'), 0);
  applyColorChange(problem, state, 2, 'C');
  assert.deepEqual([...state.refcounts].sort(), [['A', 2], ['C', 1]]);
});

test('required colors really occur and missing locked/free capacity returns structured conflicts', () => {
  const good = request([gray(0), gray(0), gray(0)], 3, { requiredColors: ['W'] });
  const result = generatePattern(good);
  assert.ok(result.cells.includes('W'));
  const conflicts: [Partial<GenerationRequest>, string][] = [
    [{ maxColors: 1, requiredColors: ['B', 'W'] }, 'COLOR_BUDGET'],
    [{ allowedColors: ['B'], requiredColors: ['W'] }, 'REQUIRED_NOT_ALLOWED'],
    [{ constraints: [{ kind: 'lock-color', cellIndices: [0], colorId: 'W' }], allowedColors: ['B'] }, 'LOCK_NOT_ALLOWED'],
    [{ constraints: [{ kind: 'lock-color', cellIndices: [0], colorId: 'B' }, { kind: 'lock-empty', cellIndices: [0] }] }, 'OVERLAPPING_LOCKS'],
    [{ requiredColors: ['W'], constraints: [{ kind: 'lock-color', cellIndices: [0, 1, 2], colorId: 'B' }] }, 'REQUIRED_CAPACITY'],
    [{ maxColors: 1, constraints: [{ kind: 'lock-color', cellIndices: [0], colorId: 'B' }, { kind: 'lock-color', cellIndices: [1], colorId: 'W' }] }, 'COLOR_BUDGET'],
  ];
  for (const [change, code] of conflicts) assert.throws(() => generatePattern({ ...good, requiredColors: undefined, ...change }), error => error instanceof ConstraintConflictError && error.code === 'INFEASIBLE_CONSTRAINTS' && error.conflicts.some(conflict => conflict.code === code));
});

test('ROI exterior locks and lock-empty remain unchanged and consume the global color budget', () => {
  const p = palette([['B', gray(0)], ['M', gray(100)], ['W', gray(255)]]);
  const req = request(Array.from({ length: 9 }, () => gray(100)), 3, { palette: p, maxColors: 2, constraints: [{ kind: 'lock-color', cellIndices: [0, 1, 2, 3], colorId: 'B' }, { kind: 'lock-color', cellIndices: [5, 6, 7], colorId: 'W' }, { kind: 'lock-empty', cellIndices: [8] }] });
  const result = generatePattern(req);
  assert.deepEqual(result.cells.slice(0, 4), ['B', 'B', 'B', 'B']);
  assert.deepEqual(result.cells.slice(5), ['W', 'W', 'W', null]);
  assert.ok(result.cells[4] === 'B' || result.cells[4] === 'W');
  assert.equal(result.diagnostics.usedColors, 2);
});

test('explicit lock-color can add a bead into an empty source cell without changing other occupancy', () => {
  const req = request([gray(0), gray(0)], 2, { image: { width: 2, height: 1, data: [0, 0, 0, 0, 0, 0, 0, 0] }, constraints: [{ kind: 'lock-color', cellIndices: [1], colorId: 'W' }] });
  assert.deepEqual(generatePattern(req).cells, [null, 'W']);
  assert.throws(() => generatePattern({ ...req, constraints: [], requiredColors: ['B'] }), error => error instanceof ConstraintConflictError && error.conflicts[0].code === 'REQUIRED_CAPACITY');
});

test('rare eye highlight survives a two-color budget that frequency reduction erases', () => {
  const p = palette([['G1', gray(20)], ['G2', gray(30)], ['W', gray(255)]]);
  const pixels = Array.from({ length: 25 }, (_, i) => gray(i === 12 ? 255 : i % 2 ? 20 : 30));
  const req = request(pixels, 5, { palette: p, maxColors: 2, style: 'clean' });
  const baseline = generatePattern({ ...req, method: 'area' }), optimized = generatePattern(req);
  assert.ok(!baseline.cells.includes('W'));
  assert.equal(optimized.cells[12], 'W');
  assert.equal(optimized.diagnostics.usedColors, 2);
  assert.ok(optimized.diagnostics.monochromeSingletons >= 1, 'a valid highlight is not blindly deleted');
});

test('minority feature colors are injected beyond nearest five and a manual anchor can retain them', () => {
  const p = palette([['G0', gray(0)], ['G1', gray(20)], ['G2', gray(40)], ['G3', gray(60)], ['G4', gray(80)], ['W', gray(255)]]);
  const req = request(Array.from({ length: 16 }, (_, i) => gray(i === 0 ? 255 : 0)), 4, { width: 1, height: 1, palette: p, maxColors: 1, constraints: [{ kind: 'feature', cellIndices: [0], colorId: 'W', strength: 2 }] });
  const problem = makeProblem(req);
  assert.ok(problem.candidates[0].includes('W'));
  assert.equal(generatePattern(req).cells[0], 'W');
  assert.equal(generatePattern({ ...req, constraints: [] }).cells[0], 'G0');
});

test('unmet soft features are visible and never weaken allowed colors or hard locks', () => {
  const req = request([gray(0)], 1, { maxColors: 1, allowedColors: ['B'], constraints: [{ kind: 'feature', cellIndices: [0], colorId: 'W' }, { kind: 'lock-color', cellIndices: [0], colorId: 'B' }] });
  const pattern = generatePattern(req);
  assert.deepEqual(pattern.cells, ['B']);
  assert.ok(pattern.diagnostics.warnings.some(warning => warning.includes('could not be retained')));
  assert.ok(pattern.diagnostics.warnings.some(warning => warning.includes('outside allowedColors')));
});

test('protect, simplify, each energy term and optional symmetry alter the intended objective', () => {
  const req = request([gray(90), gray(100), gray(110), gray(100)], 2);
  const base = makeProblem(req), protect = makeProblem({ ...req, constraints: [{ kind: 'protect', cellIndices: [0], strength: 2 }] }), simplify = makeProblem({ ...req, constraints: [{ kind: 'simplify', cellIndices: [0], strength: 2 }] });
  assert.ok(protect.costs[0][0] > base.costs[0][0]);
  assert.ok(simplify.costs[0][0] < base.costs[0][0]);
  const cells = ['B', 'W', 'B', 'B'];
  assert.ok(evaluateEnergy(protect, cells).island <= evaluateEnergy(base, cells).island);
  assert.ok(evaluateEnergy(simplify, cells).smooth > evaluateEnergy(base, cells).smooth);
  const symmetric = makeProblem({ ...req, optimization: { symmetry: true } });
  assert.equal(evaluateEnergy(base, cells).symmetry, 0);
  assert.ok(evaluateEnergy(symmetric, cells).symmetry > 0);
  for (const term of ['color', 'smooth', 'edge', 'island', 'palette', 'feature', 'symmetry'] as const) {
    const extended = { ...req, optimization: { symmetry: true }, constraints: [{ kind: 'feature' as const, cellIndices: [0], colorId: 'W' }] };
    assert.equal(evaluateEnergy(makeProblem(extended, { [term]: 0 }), cells)[term], 0);
  }
});

test('fixed budgets retain feasible best state, finite empty/one-color cases, and a nonincreasing trace', () => {
  let seed = 12345;
  const p = palette(Array.from({ length: 8 }, (_, i) => [`C${i}`, gray(i * 36)]));
  for (const maxColors of [1, 2, 5]) for (const maxEvaluations of [1, 2000]) {
    const req = request(Array.from({ length: 36 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return gray(seed % 256); }), 6, { palette: p, maxColors, optimization: { iterations: 4, maxEvaluations } });
    const first = generatePattern(req);
    assert.deepEqual(generatePattern(toJsonRequest(req)), first);
    validatePattern(first);
    assert.ok(isFeasible(makeProblem(req), first.cells));
    const report = first.diagnostics.optimization!;
    assert.ok(report.evaluations <= maxEvaluations);
    assert.ok(report.finalEnergy <= report.initialEnergy + 1e-10);
    report.trace.forEach((value, index) => assert.ok(index === 0 || value <= report.trace[index - 1] + 1e-10));
  }
  const req = request([gray(0)], 1, { image: { width: 1, height: 1, data: [0, 0, 0, 0] } });
  const empty = generatePattern(req);
  validatePattern(empty);
  assert.deepEqual(empty.cells, [null]);
  assert.equal(empty.diagnostics.optimization!.stopReason, 'empty');
  assert.equal(empty.diagnostics.optimization!.finalEnergy, 0);
  const zeroIterations = generatePattern({ ...request([gray(80), gray(180)], 2), optimization: { iterations: 0 } });
  assert.equal(zeroIterations.diagnostics.optimization!.iterations, 0);
  assert.equal(zeroIterations.diagnostics.optimization!.stopReason, 'iteration-budget');
});

test('extended options are strict and legacy methods cannot silently ignore optimization settings', () => {
  const req = request([gray(0), gray(255)], 2);
  const invalids: unknown[] = [
    { ...req, requiredColors: ['missing'] }, { ...req, requiredColors: ['W', 'W'] },
    { ...req, constraints: [{ kind: 'protect', cellIndices: [] }] },
    { ...req, constraints: [{ kind: 'feature', cellIndices: [0] }] },
    { ...req, constraints: [{ kind: 'protect', cellIndices: [0], colorId: 'B' }] },
    { ...req, constraints: [{ kind: 'lock-color', cellIndices: [0], colorId: 'B', strength: 1 }] },
    { ...req, constraints: [{ kind: 'protect', cellIndices: [2] }] },
    { ...req, constraints: [{ kind: 'protect', cellIndices: [0, 0] }] },
    { ...req, constraints: [{ kind: 'protect', cellIndices: [0], strength: NaN }] },
    { ...req, optimization: { iterations: 31 } }, { ...req, optimization: { maxEvaluations: 0 } },
    { ...req, optimization: { symmetry: 'yes' } }, { ...req, phase: [0.5, 0] },
    { ...req, method: 'area', requiredColors: ['B'] }, { ...req, method: 'nearest', optimization: {} },
  ];
  for (const invalid of invalids) assert.throws(() => validateRequest(invalid));
});

test('physical disconnection is distinct from same-color noise and reports diagonal/narrow risks', () => {
  assert.deepEqual(inspectConnectivity(['B', null, null, 'W'], 2, 2), { diagonalContacts: 1, narrowConnections: 0 });
  assert.deepEqual(inspectConnectivity(['B', 'W', 'B'], 3, 1), { diagonalContacts: 0, narrowConnections: 1 });
  const result = generatePattern(request([gray(0), gray(255), gray(0)], 3));
  assert.equal(result.diagnostics.physicalComponents, 1);
  assert.equal(result.diagnostics.narrowConnections, 1);
});

test('3x3 exhaustive evaluation measures zero optimum gap on a nontrivial full-energy fixture', () => {
  const p = palette([['0', gray(80)], ['1', gray(160)]]);
  const req = request([80, 90, 110, 100, 120, 140, 130, 150, 160].map(gray), 3, { palette: p, optimization: { symmetry: true }, constraints: [{ kind: 'feature', cellIndices: [4, 5], colorId: '1', strength: 0.03 }] });
  const problem = makeProblem(req);
  let optimum = Infinity;
  for (let bits = 0; bits < 512; bits++) {
    const cells = Array.from({ length: 9 }, (_, i) => bits & (1 << i) ? '1' : '0');
    optimum = Math.min(optimum, evaluateEnergy(problem, cells).total);
  }
  const result = generatePattern(req);
  close(optimum, 0.021002756363228134);
  close(result.diagnostics.optimization!.finalEnergy - optimum, 0);
  assert.ok(result.diagnostics.optimization!.initialEnergy > optimum);
});

test('zero-strength soft features have no side effects on candidates, weights or protection', () => {
  const req = request([gray(30), gray(120), gray(30)], 3);
  const baseline = makeProblem(req), disabled = makeProblem({ ...req, constraints: [{ kind: 'feature', cellIndices: [1], colorId: 'W', strength: 0 }] });
  assert.deepEqual(disabled.candidates, baseline.candidates);
  assert.deepEqual(disabled.protection, baseline.protection);
  assert.deepEqual(disabled.features, baseline.features);
});

test('small-component energy depends on area, protects accepted feature colors, and rebuilds after bridge splits', () => {
  const req = request(Array.from({ length: 9 }, () => gray(120)), 9, { optimization: { islandMaxSize: 4 }, constraints: [{ kind: 'feature', cellIndices: [0], colorIds: ['B'], minCells: 1, allowSingleton: true }] });
  const onlyIsland = { color: 0, smooth: 0, edge: 0, palette: 0, feature: 0, symmetry: 0, island: 1 };
  const problem = makeProblem(req, onlyIsland);
  // A size-two component contributes 3/4, a size-four component 1/4,
  // and the protected singleton contributes zero, normalized by foreground N.
  const cells = ['B', 'W', 'W', 'B', 'B', 'B', 'B', 'W', 'W'];
  close(evaluateEnergy(problem, cells).island, (0.75 + 0.25 + 0.75) / 9);
  const ordinary = makeProblem({ ...req, constraints: [{ kind: 'feature', cellIndices: [0], colorIds: ['B'], allowSingleton: false }] }, onlyIsland);
  close(evaluateEnergy(ordinary, cells).island - evaluateEnergy(problem, cells).island, 1 / 9);
  // The old all-B component had zero penalty; splitting its middle creates
  // two FOUR-cell components, including cells beyond the changed neighborhood.
  const state = createEnergyState(ordinary, Array.from({ length: 9 }, () => 'B'));
  close(energyDelta(ordinary, state, 4, 'W'), (0.25 + 1 + 0.25) / 9);
  const proposal = [...state.cells]; proposal[4] = 'W';
  close(energyDelta(ordinary, state, 4, 'W'), evaluateEnergy(ordinary, proposal).total - evaluateEnergy(ordinary, state.cells).total);
});

test('all 3x3 assignments and island thresholds agree with exact single-cell deltas including holes', () => {
  const req = request(Array.from({ length: 9 }, () => gray(120)), 3, { constraints: [{ kind: 'protect', cellIndices: [0], strength: 0.3 }] });
  for (const islandMaxSize of [1, 2, 4]) {
    const problem = makeProblem({ ...req, optimization: { islandMaxSize } }, { color: 0, smooth: 0, edge: 0, palette: 0, feature: 0, symmetry: 0, island: 1 });
    for (let mask = 0; mask < 512; mask++) {
      const cells = Array.from({ length: 9 }, (_, i) => mask & (1 << i) ? 'W' : 'B'), state = createEnergyState(problem, cells);
      const before = evaluateEnergy(problem, cells).total;
      for (let i = 0; i < 9; i++) {
        const color = cells[i] === 'W' ? 'B' : 'W', proposal = [...cells]; proposal[i] = color;
        close(energyDelta(problem, state, i, color), evaluateEnergy(problem, proposal).total - before);
        assert.deepEqual(state.cells, cells, 'delta evaluation must restore the input state');
      }
    }
  }
  const holes = makeProblem({ ...req, constraints: [{ kind: 'lock-empty', cellIndices: [4] }] });
  const state = createEnergyState(holes, ['B', 'B', 'W', 'B', null, 'W', 'W', 'W', 'W']);
  for (const i of [0, 1, 2, 3, 5, 6, 7, 8]) {
    const color = state.cells[i] === 'B' ? 'W' : 'B', proposal = [...state.cells]; proposal[i] = color;
    close(energyDelta(holes, state, i, color), evaluateEnergy(holes, proposal).total - evaluateEnergy(holes, state.cells).total);
  }
});

test('accepted-color sets and minimum counts use the planned squared deficit with exact overlap updates', () => {
  const p = palette([['A', gray(50)], ['B', gray(120)], ['C', gray(180)]]);
  const req = request(Array.from({ length: 6 }, () => gray(120)), 3, { palette: p, maxColors: 3, constraints: [
    { kind: 'feature', cellIndices: [0, 1, 2, 3], colorIds: ['A', 'B'], minCells: 3, strength: 2 },
    { kind: 'feature', cellIndices: [1, 2, 4], colorIds: ['B', 'C'], minCells: 2, strength: 0.5 },
  ] });
  const problem = makeProblem(req, { color: 0, smooth: 0, edge: 0, palette: 0, island: 0, symmetry: 0, feature: 1 });
  const state = createEnergyState(problem, ['A', 'C', 'C', 'C', 'A', 'A']);
  close(evaluateEnergy(problem, state.cells).feature, (2 * (2 / 3) ** 2 + 0) / 2);
  close(energyDelta(problem, state, 1, 'B'), (2 * (1 / 3) ** 2 - 2 * (2 / 3) ** 2) / 2);
  applyColorChange(problem, state, 1, 'B');
  assert.deepEqual(state.featureCounts, [2, 2]);
  // B -> A keeps the first count but removes one from the overlapping second.
  close(energyDelta(problem, state, 1, 'A'), 0.5 * (1 / 2) ** 2 / 2);
  applyColorChange(problem, state, 1, 'A');
  assert.deepEqual(state.featureCounts, [2, 1]);
  assert.ok(problem.warnings.some(warning => warning.includes('overlap')));
});

test('impossible minimum counts are visible while required colors and locks remain hard', () => {
  const req = request(Array.from({ length: 4 }, () => gray(0)), 2, { maxColors: 2, requiredColors: ['W'], constraints: [
    { kind: 'lock-color', cellIndices: [0], colorId: 'B' },
    { kind: 'feature', cellIndices: [0, 1], colorIds: ['W'], minCells: 3 },
    { kind: 'feature', cellIndices: [0, 1], colorIds: ['B'], minCells: 2 },
  ] });
  const result = generatePattern(req);
  assert.equal(result.cells[0], 'B');
  assert.ok(result.cells.includes('W'));
  assert.ok(result.diagnostics.warnings.some(warning => warning.includes('only 1 compatible')));
  assert.ok(result.diagnostics.warnings.some(warning => warning.includes('incompatible minimum')));
  assert.ok(result.diagnostics.warnings.some(warning => warning.includes('requested minimum counts')));
  assert.ok(isFeasible(makeProblem(req), result.cells));
});

test('fixed-seed restarts escape a single-start basin with the same total work limits', () => {
  const p = palette([70, 95, 120, 145, 170].map((v, i) => [`C${i}`, gray(v)]));
  const req = request([126, 170, 76, 80, 154, 106, 98, 84, 126, 123, 128, 85, 153, 143, 123, 71].map(gray), 4, { palette: p, maxColors: 3, optimization: { iterations: 12, maxEvaluations: 1000, seed: 123, restarts: 1 } });
  const single = generatePattern(req), multiple = generatePattern({ ...req, optimization: { ...req.optimization, restarts: 3 } });
  assert.equal(single.diagnostics.optimization!.stopReason, 'converged');
  assert.ok(multiple.diagnostics.optimization!.finalEnergy < single.diagnostics.optimization!.finalEnergy - 0.0001);
  assert.equal(multiple.diagnostics.optimization!.bestRun, 2);
  assert.equal(multiple.diagnostics.optimization!.seed, 123);
  assert.ok(multiple.diagnostics.optimization!.evaluations <= 1000);
  assert.ok(multiple.diagnostics.optimization!.iterations <= 12);
  assert.deepEqual(generatePattern(toJsonRequest({ ...req, optimization: { ...req.optimization, restarts: 3 } })), multiple);
});

test('restart accounting includes initial scores and every proposal, preserving per-run and global best traces', () => {
  const p = palette(Array.from({ length: 6 }, (_, i) => [`C${i}`, gray(35 + 35 * i)]));
  for (const maxEvaluations of [1, 2, 7, 41, 1000]) for (const restarts of [1, 3, 8]) {
    const req = request([120, 200, 70, 105, 90, 135, 190, 70, 120].map(gray), 3, { palette: p, maxColors: 3, constraints: [{ kind: 'lock-color', cellIndices: [0], colorId: 'C2' }], requiredColors: ['C5'], optimization: { iterations: 8, restarts, maxEvaluations, seed: 0 } });
    const result = generatePattern(req), report = result.diagnostics.optimization!;
    assert.ok(report.evaluations <= maxEvaluations);
    assert.ok(report.iterations <= 8);
    assert.equal(report.evaluations, report.runs!.reduce((sum, run) => sum + run.evaluations, 0));
    assert.equal(report.iterations, report.runs!.reduce((sum, run) => sum + run.iterations, 0));
    close(report.finalEnergy, Math.min(...report.runs!.map(run => run.finalEnergy)));
    close(report.initialEnergy, report.trace[0]);
    close(report.finalEnergy, report.trace[report.trace.length - 1]);
    assert.equal(report.runs![report.bestRun!].finalEnergy, report.finalEnergy);
    for (const run of report.runs!) {
      assert.ok(run.evaluations >= 1);
      close(run.trace![0], run.initialEnergy);
      close(run.trace![run.trace!.length - 1], run.finalEnergy);
      run.trace!.forEach((value, i) => assert.ok(i === 0 || value <= run.trace![i - 1]));
    }
    report.trace.forEach((value, i) => assert.ok(i === 0 || value <= report.trace[i - 1]));
    assert.ok(isFeasible(makeProblem(req), result.cells));
    assert.deepEqual(generatePattern(req), result);
  }
});

test('coherent original minority modes receive opportunity cost while equal-mass scattered noise does not', () => {
  const positions = [0, 10, 20, 30, 33, 43, 53, 63];
  const line = request(Array.from({ length: 64 }, (_, i) => gray(Math.floor(i / 8) === 3 ? 0 : 255)), 8, { width: 1, height: 1, maxColors: 1 });
  const noise = request(Array.from({ length: 64 }, (_, i) => gray(positions.includes(i) ? 0 : 255)), 8, { width: 1, height: 1, maxColors: 1 });
  const lineProblem = makeProblem(line), noiseProblem = makeProblem(noise);
  const black = lineProblem.colorIndex.get('B')!;
  assert.ok(lineProblem.costs[0][black] < noiseProblem.costs[0][black] / 10);
  assert.deepEqual(generatePattern(line).cells, ['B']);
  assert.deepEqual(generatePattern(noise).cells, ['W']);
  assert.deepEqual(generatePattern({ ...line, optimization: { unary: 'representative' } }).cells, ['W']);
});

test('original pair contrast and reliability define fixed target energy independently of filtered representatives', () => {
  const req = request([gray(100), gray(100)], 2);
  const target = sampleStructuredImage(req.image, 2, 1, patternGeometry(2, 1, 2, 1));
  target[0]!.sourceRightContrast = 0.8; target[0]!.sourceRightReliability = 0.25;
  const problem = createEnergyProblem(req, target, prepareColors(BW.colors), { color: 0, smooth: 0, edge: 1, island: 0, palette: 0, feature: 0, symmetry: 0 });
  close(evaluateEnergy(problem, ['B', 'B']).edge, 0.25 * 0.8 ** 2);
  close(evaluateEnergy(problem, ['B', 'W']).edge, 0.25 * 0.2 ** 2, 1e-8);
  const state = createEnergyState(problem, ['B', 'B']);
  close(energyDelta(problem, state, 1, 'W'), evaluateEnergy(problem, ['B', 'W']).total - evaluateEnergy(problem, ['B', 'B']).total);
  assert.equal(problem.edges[0].contrast, 0.8);
  assert.equal(problem.edges[0].reliability, 0.25);
});

test('one-column grids consume vertical original pair evidence and source-edge ablations remove guidance', () => {
  const req = request([gray(100), gray(100)], 1);
  const target = sampleStructuredImage(req.image, 1, 2, patternGeometry(1, 2, 1, 2));
  target[0]!.sourceDownContrast = 0.8; target[0]!.sourceDownReliability = 0.25;
  const weights = { color: 0, smooth: 1, edge: 1, island: 0, palette: 0, feature: 0, symmetry: 0 };
  const problem = createEnergyProblem(req, target, prepareColors(BW.colors), weights);
  close(evaluateEnergy(problem, ['B', 'B']).edge, 0.25 * 0.8 ** 2);
  close(evaluateEnergy(problem, ['B', 'W']).smooth, Math.exp(-8 * 0.8 * 0.25));
  const disabled = createEnergyProblem({ ...req, sampling: { sourceEdges: false } }, target, prepareColors(BW.colors), weights);
  assert.equal(evaluateEnergy(disabled, ['B', 'W']).edge, 0);
  assert.equal(evaluateEnergy(disabled, ['B', 'W']).smooth, 1);
});

test('explicit sampling strategies choose their own unary evidence unless overridden', () => {
  const req = request(Array.from({ length: 64 }, (_, i) => gray(Math.floor(i / 8) === 3 ? 0 : 255)), 8, { width: 1, height: 1, maxColors: 1 });
  const target = sampleStructuredImage(req.image, 1, 1, patternGeometry(8, 8, 1, 1));
  const colors = prepareColors(BW.colors);
  const modes = createEnergyProblem(req, target, colors);
  target[0]!.samplingStrategy = 'dominant';
  const dominant = createEnergyProblem(req, target, colors);
  assert.ok(dominant.costs[0][dominant.colorIndex.get('B')!] > modes.costs[0][modes.colorIndex.get('B')!] * 10);
  const overridden = createEnergyProblem({ ...req, optimization: { unary: 'modes' } }, target, colors);
  assert.deepEqual(overridden.costs, modes.costs);
});

test('cached source evidence preserves sampling strategy, source-edge ablations and final minority decisions', () => {
  const positions = [0, 10, 20, 30, 33, 43, 53, 63];
  for (const strategy of ['dominant', 'mean', 'weighted-area', 'modes'] as const) for (const sourceEdges of [false, true]) {
    const req = request(Array.from({ length: 128 }, (_, i) => gray(i % 16 < 8 ? Math.floor(i / 16) === 3 ? 0 : 255 : positions.includes(Math.floor(i / 16) * 8 + i % 16 - 8) ? 0 : 255)), 16, { width: 2, height: 1, preprocessing: { smoothing: true }, sampling: { strategy, sourceEdges } });
    const raster = createSourceRaster(req);
    const fresh = generatePattern(req);
    const { preprocessing: _preprocessing, sampling: _sampling, ...base } = req;
    const cached = generatePattern(toJsonRequest({ ...base, preparedRaster: raster }));
    assert.deepEqual(cached.cells, fresh.cells, `${strategy} sourceEdges=${sourceEdges} final cells`);
    assert.deepEqual(cached.diagnostics.optimization, fresh.diagnostics.optimization, `${strategy} sourceEdges=${sourceEdges} objective`);
    assert.deepEqual(raster.cells.map(cell => cell?.samplingStrategy), [strategy, strategy]);
  }
  const req = request([gray(0), gray(255)], 2, { sampling: { sourceEdges: false } });
  const fresh = generatePattern(req), raster = createSourceRaster(req);
  const { sampling: _sampling, ...base } = req;
  const cached = generatePattern({ ...base, preparedRaster: raster });
  assert.deepEqual(cached.cells, fresh.cells);
  assert.deepEqual(cached.diagnostics.optimization, fresh.diagnostics.optimization);
});

test('cached source feature minima count locked exterior cells alongside explicit overlapping ROI features', () => {
  const req = request([gray(0), gray(0), gray(0)], 3, { sourceFeatures: [{ id: 'marked-part', label: 'Original marked part', mask: { width: 3, height: 1, runs: [[0, 3]] }, colorIds: ['W'], minCells: 2, importance: 4, confidence: 1, allowSingleton: true }], constraints: [
    { kind: 'lock-color', cellIndices: [0], colorId: 'W' },
    { kind: 'lock-color', cellIndices: [2], colorId: 'B' },
    { kind: 'feature', cellIndices: [1, 2], colorIds: ['B'], minCells: 1 },
  ] });
  const raster = createSourceRaster(req), fresh = generatePattern(req);
  const { sourceFeatures: _features, ...base } = req;
  const cached = generatePattern({ ...base, preparedRaster: raster });
  assert.deepEqual(cached.cells, ['W', 'W', 'B']);
  assert.equal(cached.diagnostics.optimization!.terms.feature, 0);
  assert.deepEqual(cached.diagnostics.optimization, fresh.diagnostics.optimization);
  assert.ok(!cached.diagnostics.warnings.some(warning => warning.includes('could not be retained')));
  assert.throws(() => generatePattern({ ...base, preparedRaster: raster, maxColors: 1 }), error => error instanceof ConstraintConflictError && error.conflicts.some(conflict => conflict.code === 'COLOR_BUDGET'));
});

test('modes unary charges a bounded source-area loss for ignoring a coherent original minority', () => {
  const req = request(Array.from({ length: 64 }, (_, i) => gray(Math.floor(i / 8) === 3 || Math.floor(i / 8) === 4 ? 0 : 255)), 8, { width: 1, height: 1 });
  const target = sampleStructuredImage(req.image, 1, 1, patternGeometry(8, 8, 1, 1));
  target[0]!.importance = 1;
  const problem = createEnergyProblem(req, target, prepareColors(BW.colors));
  // The white assignment loses 1/4 source area at capped squared distance
  // 0.25², in addition to the existing 1/4-weighted robust mixture.
  close(problem.costs[0][problem.colorIndex.get('W')!], 0.25 * 0.25 * 0.04 + 0.25 * 0.25 ** 2);
  close(problem.costs[0][problem.colorIndex.get('B')!], 0.001 * 0.75);
  const disabled = createEnergyProblem({ ...req, sampling: { sourceEdges: false } }, target, prepareColors(BW.colors));
  close(disabled.costs[0][disabled.colorIndex.get('W')!], 0.25 * 0.25 * 0.04);
  assert.ok(disabled.costs[0][disabled.colorIndex.get('B')!] > 0.5);
});

test('source fidelity recovers existing multi-cell line regressions without enhancing the texture controls', () => {
  let retained = 0, survivingCases = 0, noiseBeads = 0, outside = 0, representativeRetained = 0, noSourceRetained = 0;
  for (const fixture of createDetailFixtures()) {
    const result = generatePattern(fixture.request), coverage = projectedFeatureCoverage(fixture);
    if (fixture.kind === 'diffuse-dark-noise') {
      noiseBeads += result.cells.filter(id => id === fixture.featureColorId).length;
      continue;
    }
    const supported = coverage.map((weight, i) => weight + 1e-12 >= 0.04 ? i : -1).filter(i => i >= 0);
    const count = supported.filter(i => result.cells[i] === fixture.featureColorId).length;
    retained += count; survivingCases += Number(count > 0);
    outside += result.cells.filter((id, i) => id === fixture.featureColorId && coverage[i] + 1e-12 < 0.04).length;
    const representative = generatePattern({ ...fixture.request, optimization: { unary: 'representative' } });
    const noSource = generatePattern({ ...fixture.request, sampling: { sourceEdges: false } });
    representativeRetained += supported.filter(i => representative.cells[i] === fixture.featureColorId).length;
    noSourceRetained += supported.filter(i => noSource.cells[i] === fixture.featureColorId).length;
  }
  assert.ok(retained >= 48, `retained ${retained} of 111 annotated detail cells`);
  assert.ok(survivingCases >= 12, `retained detail in ${survivingCases} of 30 cases`);
  assert.equal(noiseBeads, 0, 'the 15 dispersed texture controls must not gain dark beads');
  assert.equal(outside, 0, 'automatic feature-colored beads must retain source support');
  assert.equal(representativeRetained, 0, 'the historical representative objective remains a separate ablation');
  assert.equal(noSourceRetained, 0, 'disabling original evidence also disables the new fidelity contribution');
});

test('source structural costs exclude unavoidable palette error and use only allowed swatches as their fixed reference', () => {
  const p = palette([['dark', gray(20)], ['light', gray(230)]]);
  const req = request(Array.from({ length: 64 }, (_, i) => gray(Math.floor(i / 8) === 3 || Math.floor(i / 8) === 4 ? 0 : 255)), 8, { width: 1, height: 1, palette: p });
  const target = sampleStructuredImage(req.image, 1, 1, patternGeometry(8, 8, 1, 1));
  target[0]!.importance = 1;
  const problem = createEnergyProblem(req, target, prepareColors(p.colors));
  // Gray20 cannot exactly reproduce the source black. Its unavoidable mismatch
  // does not become an extra penalty for retaining the source shape.
  close(problem.costs[0][problem.colorIndex.get('dark')!], 0.001 * 0.75);
  const limited = createEnergyProblem({ ...req, allowedColors: ['light'] }, target, prepareColors(p.colors.filter(color => color.id === 'light')));
  close(limited.costs[0][0], 0.001 * 0.75);
  assert.deepEqual(limited.candidates, [['light']]);
  const state = createEnergyState(problem, ['dark']);
  close(energyDelta(problem, state, 0, 'light'), evaluateEnergy(problem, ['light']).total - evaluateEnergy(problem, ['dark']).total);
});

test('physical 221/291 palettes retain supported source details at both small and full budgets without texture or halo promotion', () => {
  for (const physical of [basicPalette, completePalette]) for (const maxColors of [8, 221]) {
    const p = workspacePalette(physical), colors = prepareColors(p.colors);
    let retained = 0, outside = 0, noise = 0;
    for (const fixture of createDetailFixtures()) {
      // Freeze acceptable output swatches from the ORIGINAL source references
      // before generating output; annotations never enter the optimizer.
      const feature = linearToOklab(srgb8ToLinear(fixture.request.palette.colors.find(color => color.id === fixture.featureColorId)!.srgb8));
      const background = linearToOklab(srgb8ToLinear(fixture.request.palette.colors.find(color => color.id === (fixture.kind === 'bright-highlight' ? 'D' : 'Y'))!.srgb8));
      const nearest = Math.min(...colors.map(color => oklabDistance(color.oklab, feature)));
      const accepted = new Set(colors.filter(color => oklabDistance(color.oklab, feature) <= Math.max(0.06, nearest + 0.02) && oklabDistance(color.oklab, feature) < 0.5 * oklabDistance(color.oklab, background)).map(color => color.id));
      const result = generatePattern({ ...fixture.request, palette: p, maxColors }), coverage = projectedFeatureCoverage(fixture);
      assert.ok(result.diagnostics.usedColors <= maxColors);
      result.cells.forEach((color, index) => {
        if (color === null || !accepted.has(color)) return;
        if (fixture.kind === 'diffuse-dark-noise') noise++;
        else if (coverage[index] + 1e-12 >= 0.04) retained++;
        else outside++;
      });
    }
    assert.ok(retained >= 48, `${physical.length} allowed colors, budget ${maxColors}: ${retained}/111`);
    assert.equal(noise, 0, `${physical.length} allowed colors, budget ${maxColors}: texture enhancement`);
    assert.equal(outside, 0, `${physical.length} allowed colors, budget ${maxColors}: unsupported halo`);
  }
});

test('two-to-four-percent source modes stay candidates without automatic preservation while explicit features remain usable', () => {
  const thin = request(Array.from({ length: 10_000 }, (_, i) => gray(Math.floor(i / 100) >= 48 && Math.floor(i / 100) < 51 ? 255 : 0)), 100, { width: 1, height: 1, maxColors: 1 });
  const problem = makeProblem(thin), white = problem.colorIndex.get('W')!;
  assert.ok(problem.target[0]!.modes.some(mode => (mode.sourceWeight ?? mode.weight) > 0.02 && (mode.sourceWeight ?? mode.weight) < 0.04 && (mode.structuralSupport ?? 0) >= 0.5));
  assert.ok(problem.candidates[0].includes('W'));
  assert.ok(problem.costs[0][white] > 0.5, 'candidate presence is not automatic evidence that one bead is warranted');
  assert.deepEqual(generatePattern(thin).cells, ['B']);
  assert.deepEqual(generatePattern({ ...thin, constraints: [{ kind: 'feature', cellIndices: [0], colorId: 'W', strength: 2 }] }).cells, ['W']);
  const supported = { ...thin, image: { ...thin.image, data: Array.from({ length: 10_000 }, (_, i) => [...gray(Math.floor(i / 100) >= 48 && Math.floor(i / 100) < 52 ? 255 : 0), 255]).flat() } };
  assert.deepEqual(generatePattern(supported).cells, ['W']);
});

test('automatic source-component conditions keep manual normalization, deduplicate evidence and yield to explicit soft controls', () => {
  const req = request([gray(255), gray(255), gray(255), gray(255)], 4, { constraints: [{ kind: 'feature', cellIndices: [0], colorId: 'B', strength: 2 }] });
  const target = sampleStructuredImage(req.image, 4, 1, patternGeometry(4, 1, 4, 1));
  const black = prepareColors(BW.colors).find(color => color.id === 'B')!.oklab;
  const append = (i: number, id: number) => target[i]!.modes.push({ color: black, weight: 0, sourceWeight: 0.2, structuralSupport: 0.8, compactSupport: 0.8, boundarySupport: 0, sourceContrast: 1,
    components: [{ id, coverage: 0.2, support: 0.8, kind: 'compact', span: 0.5 }] });
  append(2, 10); append(2, 10); append(3, 11);
  const weights = { color: 0, smooth: 0, edge: 0, island: 0, palette: 0, symmetry: 0, feature: 1 };
  const problem = createEnergyProblem(req, target, prepareColors(BW.colors), weights);
  assert.equal(problem.features.filter(feature => feature.origin === 'manual')[0].normalizer, 1);
  assert.equal(problem.features.filter(feature => feature.origin === 'source').length, 2);
  close(evaluateEnergy(problem, ['W', 'W', 'W', 'W']).feature, 2 + 0.16 / 4 + 0.16 / 4);
  close(evaluateEnergy(problem, ['W', 'W', 'B', 'B']).feature, 2);
  const disabled = createEnergyProblem({ ...req, optimization: { sourceComponents: false } }, target, prepareColors(BW.colors), weights);
  assert.equal(disabled.features.length, 1);
  close(evaluateEnergy(disabled, ['W', 'W', 'W', 'W']).feature, 2);
  for (const kind of ['protect', 'simplify'] as const) {
    const controlled = createEnergyProblem({ ...req, constraints: [...req.constraints!, { kind, cellIndices: [2], strength: 1 }] }, target, prepareColors(BW.colors), weights);
    assert.deepEqual(controlled.features.filter(feature => feature.origin === 'source').map(feature => feature.sourceComponentId), [11]);
  }
  for (const change of [{ sampling: { sourceEdges: false } }, { optimization: { unary: 'representative' as const } }, { style: 'pixel-input' as const }]) {
    assert.equal(createEnergyProblem({ ...req, ...change }, target, prepareColors(BW.colors), weights).features.filter(feature => feature.origin === 'source').length, 0);
  }
  // These costs exercise both manual and automatic count changes independently.
  const state = createEnergyState(problem, ['W', 'W', 'W', 'W']);
  for (const i of [2, 0, 3, 2, 0, 3]) {
    const color = state.cells[i] === 'W' ? 'B' : 'W', proposal = [...state.cells]; proposal[i] = color;
    close(energyDelta(problem, state, i, color), evaluateEnergy(problem, proposal).total - evaluateEnergy(problem, state.cells).total);
    applyColorChange(problem, state, i, color);
    assert.deepEqual(state.featureCounts, createEnergyState(problem, state.cells).featureCounts);
  }
});

test('known broad regions keep ordinary color fidelity and automatic component groups have a deterministic bound', () => {
  const req = request(Array.from({ length: 65 }, () => gray(0)), 65);
  const target = sampleStructuredImage(req.image, 65, 1, patternGeometry(65, 1, 65, 1));
  const white = prepareColors(BW.colors).find(color => color.id === 'W')!.oklab;
  for (let i = 0; i < target.length; i++) target[i]!.modes.push({ color: white, weight: 0, sourceWeight: 0.1, structuralSupport: 1, boundarySupport: 1, compactSupport: 0, sourceContrast: 1, components: [] });
  const broad = createEnergyProblem(req, target, prepareColors(BW.colors));
  assert.ok(broad.costs[0][broad.colorIndex.get('W')!] > 0.5);
  for (let i = 0; i < target.length; i++) target[i]!.modes[1].components = [{ id: i, coverage: .1, support: 1, kind: 'region', span: 3, contrast: 1 }];
  const regions = createEnergyProblem(req, target, prepareColors(BW.colors));
  assert.ok(regions.costs[0][regions.colorIndex.get('W')!] > .5, 'filled regions cannot inherit the narrow-minority opportunity discount');
  assert.equal(regions.features.filter(feature => feature.purpose === 'presence').length, 0);
  for (let i = 0; i < target.length; i++) target[i]!.modes[1].components = [{ id: i, coverage: 0.1, support: 1, kind: 'compact', span: 0.5 }];
  const bounded = createEnergyProblem(req, target, prepareColors(BW.colors));
  assert.equal(bounded.features.filter(feature => feature.origin === 'source').length, 64);
  assert.deepEqual(bounded.features.map(feature => feature.sourceComponentId), Array.from({ length: 64 }, (_, i) => i));
});

test('source component soft groups restore physical face parts while all frozen negative controls stay unchanged', () => {
  let retained = 0, presenceRetained = 0, noAutoRetained = 0;
  for (const fixture of createG2Fixtures().filter(fixture => fixture.group === 'new-mard' || fixture.negative)) {
    const result = generatePattern(fixture.request);
    if (fixture.negative) {
      const region = projectG2Mask(fixture, fixture.negativeRegionMask!);
      const accepted = new Set(acceptableG2Colors(fixture.request.palette, fixture.negativeBackgroundRgb!));
      result.cells.forEach((id, index) => { if (id !== null && region[index] + 1e-12 >= 0.5) assert.ok(accepted.has(id), `${fixture.id}: negative cell ${index}`); });
      continue;
    }
    // Isolate the original presence condition on both sides. New cross-bin,
    // shape and chromatic-region support can independently retain these parts;
    // their success must not invalidate this narrower contribution check.
    const presenceRequest = { ...fixture.request, sampling: { ...fixture.request.sampling, crossBinStrokes: false }, optimization: { ...fixture.request.optimization, sourceShapes: false, sourceColors: false } };
    const withPresence = generatePattern(presenceRequest);
    const noAuto = generatePattern({ ...presenceRequest, optimization: { ...presenceRequest.optimization, sourceComponents: false } });
    for (const part of fixture.parts) {
      const coverage = projectG2Mask(fixture, part.sourceMask), allowed = projectG2Mask(fixture, part.sourceAllowedMask);
      const accepted = new Set(acceptableG2Colors(fixture.request.palette, part.featureRgb, part.backgroundRgb));
      const count = result.cells.filter((id, i) => id !== null && accepted.has(id) && coverage[i] + 1e-12 >= 0.04).length;
      assert.ok(count > 0, `${fixture.id}/${part.id}: source part erased`);
      retained += count;
      presenceRetained += withPresence.cells.filter((id, i) => id !== null && accepted.has(id) && coverage[i] + 1e-12 >= 0.04).length;
      noAutoRetained += noAuto.cells.filter((id, i) => id !== null && accepted.has(id) && coverage[i] + 1e-12 >= 0.04).length;
      result.cells.forEach((id, i) => { if (id !== null && accepted.has(id)) assert.ok(allowed[i] + 1e-12 >= 0.04, `${fixture.id}/${part.id}: unsupported output ${i}`); });
    }
  }
  assert.ok(retained >= 60, `retained ${retained}/80 original face-detail cells`);
  assert.ok(presenceRetained > noAutoRetained, 'automatic component conditions must have a measurable same-input benefit');
});

test('clean palette regularization preserves a coherent colored accent within the same hard two-color budget', () => {
  // Self-authored numerical fixture, independent of private image pixels: a
  // filled 2x2 teal accent on a uniform 20x20 gray field. It has no annotation,
  // required color, or eligible automatic source-component condition.
  const p = palette([['gray', [160, 160, 160]], ['teal', [80, 180, 180]]]);
  const expected = Array.from({ length: 400 }, (_, i) => i % 20 >= 9 && i % 20 <= 10 && Math.floor(i / 20) >= 9 && Math.floor(i / 20) <= 10 ? 'teal' : 'gray');
  const byId = new Map(p.colors.map(color => [color.id, color.srgb8]));
  const req = request(expected.map(id => byId.get(id)!), 20, { palette: p, maxColors: 2, style: 'clean', optimization: { iterations: 6, maxEvaluations: 20_000, restarts: 1 } });
  const problem = makeProblem(req), oldRequest = { ...req, optimization: { ...req.optimization, weights: { palette: 0.0005 } } }, oldProblem = makeProblem(oldRequest);
  assert.equal(problem.features.length, 0);
  const uniform = expected.map(() => 'gray');
  assert.ok(evaluateEnergy(problem, expected).total < evaluateEnergy(problem, uniform).total);
  assert.ok(evaluateEnergy(oldProblem, expected).total > evaluateEnergy(oldProblem, uniform).total);
  const current = generatePattern(req), old = generatePattern(oldRequest);
  assert.deepEqual(current.cells, expected);
  assert.deepEqual(old.cells, uniform);
  assert.equal(current.diagnostics.usedColors, 2);
  assert.equal(old.diagnostics.usedColors, 1);
  const bom = buildBom(current);
  assert.equal(bom.totalBeads, 400);
  assert.equal(bom.rows.find(row => row.colorId === 'teal')?.count, 4);
  assert.ok(isFeasible(problem, current.cells));
  assert.ok(isFeasible(oldProblem, old.cells));
  assert.deepEqual(generatePattern(toJsonRequest(req)), current);
});

function sourceShapeFixture(closed = false) {
  const req = request(Array.from({ length: 25 }, () => gray(255)), 5, { style: 'clean', optimization: { sourceComponents: false, sourceColors: false } });
  const colors = prepareColors(BW.colors), black = colors.find(color => color.id === 'B')!.oklab;
  const target = sampleStructuredImage(req.image, 5, 5, patternGeometry(5, 5, 5, 5));
  // This hand-authored source raster represents ambiguous sub-bead structure;
  // it supplies no confident mean-to-mean edge target across these cells.
  for (const cell of target) if (cell) { cell.sourceRightReliability = 0; cell.sourceDownReliability = 0; }
  const indices = closed ? [6, 7, 8, 11, 13, 16, 17, 18] : [5, 11, 12, 13, 9];
  for (const [position, index] of indices.entries()) target[index]!.modes.push({ color: black, weight: 0, sourceWeight: .2, structuralSupport: 1, sourceContrast: 1,
    components: [{ id: 7, coverage: .2, support: 1, kind: 'stroke', span: 5, thickness: .2, closed, endpointMask: closed ? 0 : position === 0 ? 1 : position === indices.length - 1 ? 2 : 0 }] });
  return { req, target, colors, indices };
}

test('source shape scoring distinguishes a continuous curve, missing endpoints, disconnected dashes and an erased interior', () => {
  for (const closed of [false, true]) {
    const { req, target, colors, indices } = sourceShapeFixture(closed), problem = createEnergyProblem(req, target, colors);
    assert.equal(problem.sourceShapes.shapes.length, 1);
    const shape = problem.sourceShapes.shapes[0], complete = target.map(() => 'W');
    for (const vertex of shape.path) complete[shape.indices[vertex]] = 'B';
    close(sourceShapeCost(shape, complete, 5, 5), 0);
    if (closed) {
      assert.ok(shape.path.length < indices.length, 'the whole source envelope is not the desired bead thickness');
      const thick = [...complete]; for (const index of indices) thick[index] = 'B';
      assert.ok(sourceShapeCost(shape, thick, 5, 5) > 0, 'a thickened ring has a cost even when its interior remains open');
    }
    const gap = [...complete]; gap[closed ? shape.indices[shape.path[0]] : 12] = 'W';
    assert.ok(sourceShapeCost(shape, gap, 5, 5) > 0, 'a missing connective segment must have a geometric cost');
    const broken = [...complete]; broken[closed ? 12 : indices[0]] = closed ? 'B' : 'W';
    assert.ok(sourceShapeCost(shape, broken, 5, 5) > 0, closed ? 'filling a proven contrasting interior must cost energy' : 'erasing one proven source endpoint must cost energy');
    assert.equal(shape.interior.length, closed ? 1 : 0);
  }
});

test('exhaustive stroke and closed-hole deltas rebuild exactly after bridge, endpoint and interior changes', () => {
  let checked = 0;
  for (const closed of [false, true]) {
    const { req, target, colors, indices } = sourceShapeFixture(closed), problem = createEnergyProblem(req, target, colors);
    const mutable = closed ? [...indices, 12] : indices;
    for (let mask = 0; mask < 2 ** mutable.length; mask++) {
      const cells = target.map(() => 'W'); mutable.forEach((index, bit) => { if (mask & (1 << bit)) cells[index] = 'B'; });
      const state = createEnergyState(problem, cells), before = evaluateEnergy(problem, cells).total;
      for (const index of mutable) {
        const color = cells[index] === 'B' ? 'W' : 'B', proposal = [...cells]; proposal[index] = color;
        close(energyDelta(problem, state, index, color), evaluateEnergy(problem, proposal).total - before);
        assert.deepEqual(state.cells, cells, 'delta cannot mutate source state'); checked++;
      }
      const index = mutable[mask % mutable.length]; applyColorChange(problem, state, index, cells[index] === 'B' ? 'W' : 'B');
      assert.deepEqual(state.shapeCosts, createEnergyState(problem, state.cells).shapeCosts);
    }
  }
  assert.equal(checked, 4768);
});

test('source shape repairs preserve exterior cells and hard locks, honor budgets and consume no invented source vertices', () => {
  const { req, target, colors, indices } = sourceShapeFixture();
  const problem = createEnergyProblem({ ...req, constraints: [{ kind: 'lock-color', colorId: 'W', cellIndices: [12] }] }, target, colors);
  const cells = target.map(() => 'W'), state = createEnergyState(problem, cells);
  const proposals = [...sourceShapeProposals(problem, state, 1)];
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0][12], 'W');
  assert.ok(isFeasible(problem, proposals[0]));
  proposals[0].forEach((color, index) => { if (!indices.includes(index)) assert.equal(color, cells[index]); });
  const tight = createEnergyProblem({ ...req, maxColors: 1 }, target, colors);
  assert.deepEqual([...sourceShapeProposals(tight, createEnergyState(tight, cells), 12)], []);
  // Removing the sole supported middle vertex disconnects the original graph;
  // a shortcut through a white cell must never be invented by a repair.
  target[12]!.modes.splice(1);
  assert.equal(createEnergyProblem(req, target, colors).sourceShapes.shapes.length, 0);
});

test('source shape evidence is deduplicated, independently ablated and yields to explicit manual intent', () => {
  const { req, target, colors, indices } = sourceShapeFixture();
  const original = createEnergyProblem(req, target, colors), strength = original.sourceShapes.shapes[0].strength;
  assert.equal(createEnergyProblem({ ...req, allowedColors: ['W'] }, target, colors.filter(color => color.id === 'W')).sourceShapes.shapes.length, 0, 'an allowed palette that cannot distinguish the source line cannot claim shape evidence');
  target[indices[0]]!.modes.push({ ...target[indices[0]]!.modes[1] });
  const duplicated = createEnergyProblem(req, target, colors);
  close(duplicated.sourceShapes.shapes[0].strength, strength);
  assert.deepEqual(duplicated.costs, original.costs, 'canonical and raw references cannot charge the same original component area twice');
  for (const change of [
    { optimization: { sourceShapes: false } }, { optimization: { unary: 'representative' as const } },
    { sampling: { sourceEdges: false } }, { style: 'pixel-input' as const }, { optimization: { weights: { feature: 0 } } },
    { constraints: [{ kind: 'simplify' as const, cellIndices: [indices[0]] }] },
    { constraints: [{ kind: 'protect' as const, cellIndices: [indices[0]] }] },
    { constraints: [{ kind: 'feature' as const, cellIndices: [indices[0]], colorId: 'B' }] },
  ]) assert.equal(createEnergyProblem({ ...req, ...change }, target, colors).sourceShapes.shapes.length, 0);
  for (const cell of target) for (const mode of cell!.modes) for (const component of mode.components ?? []) delete component.endpointMask;
  assert.equal(createEnergyProblem(req, target, colors).sourceShapes.shapes.length, 0, 'old caches without endpoint proof keep presence behavior');
});

test('closed interior matching accepts equivalent source whites without consuming another palette slot', () => {
  const { req, target } = sourceShapeFixture(true), p = palette([['B', gray(0)], ['W', gray(255)], ['W2', gray(245)]]);
  const problem = createEnergyProblem({ ...req, palette: p }, target, prepareColors(p.colors));
  const shape = problem.sourceShapes.shapes[0];
  assert.deepEqual([...shape.interior[0].acceptedColors].sort(), ['W', 'W2']);
  const initial = target.map(() => 'W2');
  const proposals = [...sourceShapeProposals(problem, createEnergyState(problem, initial), 2)];
  assert.ok(proposals.length > 0);
  for (const proposal of proposals) {
    assert.ok(isFeasible(problem, proposal));
    assert.equal(proposal[12], 'W2');
    assert.equal(new Set(proposal).size, 2);
    close(sourceShapeCost(shape, proposal, 5, 5), 0);
  }
  const without = createEnergyProblem({ ...req, palette: p, optimization: { ...req.optimization, weights: { feature: 0 } } }, target, prepareColors(p.colors));
  assert.equal(without.sourceShapes.shapes.length, 0);
  const manual = createEnergyProblem({ ...req, palette: p, constraints: [{ kind: 'simplify', cellIndices: [12] }] }, target, prepareColors(p.colors));
  assert.equal(manual.sourceShapes.shapes.length, 0, 'manual interior intent overrides the paired automatic condition');
});

test('a whole shape proposal can replace the final old color reference at a full palette budget', () => {
  const { req, target } = sourceShapeFixture(true), p = palette([['B', gray(0)], ['W', gray(255)], ['G', gray(160)]]);
  const problem = createEnergyProblem({ ...req, palette: p, maxColors: 2 }, target, prepareColors(p.colors));
  const cells = target.map(() => 'B'); cells[12] = 'G';
  assert.ok(isFeasible(problem, cells));
  const proposals = [...sourceShapeProposals(problem, createEnergyState(problem, cells), 2)];
  assert.ok(proposals.some(proposal => proposal[12] === 'W' && !proposal.includes('G')));
  for (const proposal of proposals) assert.ok(isFeasible(problem, proposal));
});

test('shape optimization preserves a supported curve deterministically within the shared work budget', () => {
  const { req, target, colors, indices } = sourceShapeFixture();
  const options = { ...req.optimization, seed: 4378, restarts: 3, iterations: 9, maxEvaluations: 2400 };
  const current = optimizePattern({ ...req, optimization: options }, target, colors);
  const without = optimizePattern({ ...req, optimization: { ...options, sourceShapes: false } }, target, colors);
  assert.ok(indices.every(i => current.cells[i] === 'B'));
  assert.ok(indices.some(i => without.cells[i] !== 'B'), 'the shape constraint must provide an observable same-input benefit');
  assert.ok(current.report.evaluations <= options.maxEvaluations);
  assert.equal(current.report.evaluations, current.report.runs!.reduce((sum, run) => sum + run.evaluations, 0));
  assert.equal(current.report.iterations, current.report.runs!.reduce((sum, run) => sum + run.iterations, 0));
  assert.ok(current.report.iterations <= options.iterations);
  for (const run of current.report.runs!) for (let i = 1; i < run.trace.length; i++) assert.ok(run.trace[i] <= run.trace[i - 1]);
  close(current.report.finalEnergy, evaluateEnergy(current.problem, current.cells).total);
  assert.ok(isFeasible(current.problem, current.cells));
  const repeat = optimizePattern({ ...req, optimization: options }, target, colors);
  assert.deepEqual(repeat.cells, current.cells);
  assert.deepEqual(repeat.report, current.report);
});

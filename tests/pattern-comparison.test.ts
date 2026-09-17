import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPatternEquivalent } from './support/pattern-assertions';

test('cross-engine comparison permits diagnostic roundoff but rejects changed patterns and identities', () => {
  const expected = { cells: ['black', null], configHash: 'stable', diagnostics: { optimization: { finalEnergy: .1, evaluations: 8, trace: [.1], terms: { color: .1 } } } };
  const tiny = structuredClone(expected); tiny.diagnostics.optimization.finalEnergy += Number.EPSILON;
  assertPatternEquivalent(tiny, expected);
  for (const mutate of [
    (p: typeof expected) => { p.cells[0] = 'white'; },
    (p: typeof expected) => { p.configHash = 'different'; },
    (p: typeof expected) => { p.diagnostics.optimization.evaluations++; },
    (p: typeof expected) => { p.diagnostics.optimization.finalEnergy += 1e-8; },
    (p: typeof expected) => { p.diagnostics.optimization.trace.push(.1); },
  ]) {
    const changed = structuredClone(expected); mutate(changed);
    assert.throws(() => assertPatternEquivalent(changed, expected));
  }
});

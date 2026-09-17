import assert from 'node:assert/strict';

/** Only optimizer energy diagnostics allow engine-level arithmetic roundoff.
 * Cells, hashes, palette data, counts, constraints and source evidence stay exact. */
export function assertPatternEquivalent(actual: unknown, expected: unknown): void {
  function compare(value: any, reference: any, path: string): any {
    const energy = /\.diagnostics\.optimization\.(?:(?:runs\.\d+\.)?(?:initialEnergy|finalEnergy|trace\.\d+)|terms\.(?:color|edge|feature|island|palette|smooth|symmetry|total))$/.test(path);
    if (energy && typeof value === 'number' && typeof reference === 'number') {
      assert.ok(Number.isFinite(value) && Number.isFinite(reference), `${path}: finite energy required`);
      const tolerance = 32 * Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(reference));
      assert.ok(Math.abs(value - reference) <= tolerance, `${path}: ${value} differs from ${reference}`);
      return reference;
    }
    if (Array.isArray(value) && Array.isArray(reference)) return value.map((item, i) => compare(item, reference[i], `${path}.${i}`));
    if (value && reference && typeof value === 'object' && typeof reference === 'object' && !ArrayBuffer.isView(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compare(item, reference[key], `${path}.${key}`)]));
    }
    return value;
  }
  assert.deepStrictEqual(compare(actual, expected, ''), expected);
}

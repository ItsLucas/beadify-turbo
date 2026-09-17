import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/project';
import { recolorLayers, selectionRectFromPoints } from '../src/recolor';

test('rectangle normalizes reverse drags and clamps to the grid, including single cells', () => {
  assert.deepEqual(selectionRectFromPoints({ x: 4, y: 3 }, { x: -10, y: 20 }, 6, 5), { left: 0, top: 3, right: 4, bottom: 4 });
  assert.deepEqual(selectionRectFromPoints({ x: 2, y: 1 }, { x: 2.9, y: 1.9 }, 6, 5), { left: 2, top: 1, right: 2, bottom: 1 });
});

test('recolor changes disconnected matches only inside the rectangle across editable layers', () => {
  const base = createProject(4, 3).layers[0];
  base.cells = ['a', 'a', null, 'a', 'a', 'b', 'a', 'a', 'a', 'a', 'a', 'a'];
  const layers = [base, { ...base, id: 'upper', cells: base.cells.slice() }, { ...base, id: 'locked', locked: true }, { ...base, id: 'hidden', visible: false }];
  const original = structuredClone(layers);
  const result = recolorLayers(layers, 4, 'a', 'c', { left: 1, top: 0, right: 2, bottom: 1 });
  assert.equal(result.changed, 4);
  assert.deepEqual(result.layers[0].cells, ['a', 'c', null, 'a', 'a', 'b', 'c', 'a', 'a', 'a', 'a', 'a']);
  assert.deepEqual(result.layers[1].cells, result.layers[0].cells);
  assert.equal(result.layers[2], layers[2]);
  assert.equal(result.layers[3], layers[3]);
  assert.deepEqual(layers, original);
});

test('whole-pattern replacement remains available and no-op replacements do not report changes', () => {
  const layer = createProject(3, 1).layers[0];
  layer.cells = ['a', null, 'a'];
  assert.deepEqual(recolorLayers([layer], 3, 'a', 'b').layers[0].cells, ['b', null, 'b']);
  for (const [source, target] of [['a', 'a'], ['missing', 'b'], ['', 'b']]) {
    const result = recolorLayers([layer], 3, source, target);
    assert.equal(result.changed, 0);
    assert.equal(result.layers[0], layer);
  }
});

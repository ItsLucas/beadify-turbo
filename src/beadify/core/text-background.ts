import type { BeadPattern, TextAnalysis } from '../contracts';
import { linearToOklab, oklabDistance, srgb8ToLinear, type LinearRgb } from './color';
import { textPointInside } from './text-extraction';
import { transformTextPoint } from './text-analysis';

export type RetypeBackgroundMode = 'surrounding' | 'blend-color';

/** Restore erased strokes using a harmonic continuation of known neighboring
 * background. Known texture stays untouched; no model or white fallback. */
export function rebuildTextBackground(base: BeadPattern, analysis: TextAnalysis, regionId: string, mode: RetypeBackgroundMode = 'surrounding', chosenColor?: string) {
  const region = analysis.regions.find(r => r.id === regionId);
  if (!region) throw new Error('未找到文字区域');
  const polygon = region.polygon.map(point => transformTextPoint(base.geometry.sourceToGrid, point));
  const cells = [...base.cells], count = cells.length, inside = new Uint8Array(count), unknown = new Uint8Array(count);
  const left = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[0])))), right = Math.min(base.width, Math.ceil(Math.max(...polygon.map(p => p[0]))));
  const top = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[1])))), bottom = Math.min(base.height, Math.ceil(Math.max(...polygon.map(p => p[1]))));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = y * base.width + x;
    if (base.cells[i] !== null && textPointInside(x + .5, y + .5, polygon)) inside[i] = 1;
  }
  const ink = new Float64Array(count), knownBackground = new Float64Array(count);
  const m = base.geometry.sourceToGrid;
  for (const e of analysis.evidence.filter(e => e.regionId === regionId && e.status === 'verified')) {
    const coverage = e.kind === 'background' ? knownBackground : ink;
    for (const [start, length] of e.runs) for (let i = start; i < start + length; i++) {
      const sx = i % analysis.source.width, sy = Math.floor(i / analysis.source.width);
      const crop = base.geometry.crop ?? [0, 0, analysis.source.width, analysis.source.height];
      if (sx < crop[0] || sy < crop[1] || sx >= crop[2] || sy >= crop[3]) continue;
      const [x0, y0] = transformTextPoint(m, [sx, sy]), [x1, y1] = transformTextPoint(m, [sx + 1, sy + 1]);
      for (let y = Math.max(top, Math.floor(y0)); y < Math.min(bottom, Math.ceil(y1)); y++) for (let x = Math.max(left, Math.floor(x0)); x < Math.min(right, Math.ceil(x1)); x++) {
        coverage[y * base.width + x] += Math.max(0, Math.min(x + 1, x1) - Math.max(x, x0)) * Math.max(0, Math.min(y + 1, y1) - Math.max(y, y0));
      }
    }
  }
  const hasInk = ink.some(v => v > 1e-8), indices: number[] = [];
  for (let i = 0; i < count; i++) if (inside[i] && (mode === 'blend-color' || (hasInk ? ink[i] > 1e-8 : knownBackground[i] < .5))) { unknown[i] = 1; indices.push(i); }
  const colorMap = new Map(base.paletteSnapshot.colors.map(c => [c.id, srgb8ToLinear(c.srgb8)]));
  const field = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const color = base.cells[i] === null ? undefined : colorMap.get(base.cells[i]!);
    if (color) field.set([color.r, color.g, color.b], i * 3);
  }
  const neighbors = (i: number) => {
    const x = i % base.width, y = Math.floor(i / base.width), result: number[] = [];
    if (x > 0) result.push(i - 1); if (x + 1 < base.width) result.push(i + 1);
    if (y > 0) result.push(i - base.width); if (y + 1 < base.height) result.push(i + base.width);
    return result.filter(n => base.cells[n] !== null);
  };
  const adjacency = indices.map(neighbors), seen = new Uint8Array(count), depth = new Uint16Array(count);
  // Initialize each hole from its own boundary, so distant background colors
  // cannot contaminate a disconnected letter or transparency-separated region.
  for (const start of indices) {
    if (seen[start]) continue;
    const component = [start], boundary = new Set<number>(); seen[start] = 1;
    for (let head = 0; head < component.length; head++) for (const n of neighbors(component[head])) {
      if (!unknown[n]) boundary.add(n); else if (!seen[n]) { seen[n] = 1; component.push(n); }
    }
    if (!boundary.size) throw new Error('文字区域没有可采样的周围背景，请缩小区域或补充背景标注');
    const mean = [0, 1, 2].map(c => [...boundary].reduce((sum, i) => sum + field[i * 3 + c], 0) / boundary.size);
    const queue: number[] = [];
    for (const i of component) {
      field.set(mean, i * 3);
      if (neighbors(i).some(n => !unknown[n])) { depth[i] = 1; queue.push(i); }
    }
    for (let head = 0; head < queue.length; head++) for (const n of neighbors(queue[head])) if (unknown[n] && !depth[n]) { depth[n] = depth[queue[head]] + 1; queue.push(n); }
  }
  for (let iteration = 0; iteration < 192; iteration++) {
    let delta = 0;
    for (let p = 0; p < indices.length; p++) {
      const i = indices[p], adjacent = adjacency[p];
      for (let c = 0; c < 3; c++) {
        const average = adjacent.reduce((sum, n) => sum + field[n * 3 + c], 0) / adjacent.length;
        delta = Math.max(delta, Math.abs(average - field[i * 3 + c])); field[i * 3 + c] = average;
      }
    }
    if (delta < 1e-6) break;
  }
  const used = new Set(base.cells.filter((c): c is string => c !== null));
  if (mode === 'blend-color' && chosenColor) used.add(chosenColor);
  const palette = base.paletteSnapshot.colors.filter(c => used.has(c.id)).map(c => ({ id: c.id, lab: linearToOklab(srgb8ToLinear(c.srgb8)) }));
  const chosen = chosenColor ? colorMap.get(chosenColor) : undefined;
  const transition = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (const i of indices) {
    const rgb: LinearRgb = { r: field[i * 3], g: field[i * 3 + 1], b: field[i * 3 + 2] };
    if (mode === 'blend-color' && chosen) {
      const distance = Math.min(1, Math.max(0, depth[i] - 1) / 4), mix = distance * distance * (3 - 2 * distance);
      // Individual beads cannot be translucent. Ordered coverage produces an
      // actual gradual transition even when the budget permits only two colors.
      const threshold = (transition[(Math.floor(i / base.width) % 4) * 4 + i % base.width % 4] + .5) / 16;
      if (mix > threshold) { cells[i] = chosenColor!; continue; }
    }
    const lab = linearToOklab(rgb); let best = palette[0], distance = Infinity;
    for (const c of palette) { const d = oklabDistance(c.lab, lab); if (d < distance) { best = c; distance = d; } }
    cells[i] = best.id;
  }
  return { cells, repairedCells: indices, sourceInkUsed: hasInk, mode };
}

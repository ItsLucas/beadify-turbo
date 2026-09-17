/** Independent source-area diagnostic. No optimizer candidates or OCR output labels. */
import type { BeadPattern } from '../src/beadify/contracts';
import type { TextFixture } from './text-fixtures';
import { linearToOklab, oklabDistance, prepareColors, srgb8ToLinear } from '../src/beadify/core/color';

function components(mask: boolean[], width: number, diagonal: boolean) {
  const remaining = new Set(mask.flatMap((v, i) => v ? [i] : [])), result: number[][] = [], height = mask.length / width;
  for (const start of remaining) {
    remaining.delete(start); const group = [start];
    for (let at = 0; at < group.length; at++) {
      const i = group[at], x = i % width, y = Math.floor(i / width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!diagonal && Math.abs(dx) + Math.abs(dy) !== 1) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
        const next = (y + dy) * width + x + dx; if (remaining.delete(next)) group.push(next);
      }
    }
    result.push(group);
  }
  return result;
}
export function scoreTextFixture(fixture: TextFixture, pattern: BeadPattern) {
  if (fixture.negative) return null;
  const size = pattern.cells.length, width = fixture.image.width, height = fixture.image.height;
  const scale = Math.min(pattern.width / width, pattern.height / height), dx = (pattern.width - width * scale) / 2, dy = (pattern.height - height * scale) / 2;
  const sourceInk = Array<boolean>(width * height).fill(false), roi = Array<boolean>(size).fill(false);
  const roles = fixture.sourceLabels.masks.map(mask => {
    const mass = new Float64Array(size), rgb = Array.from({ length: size }, () => [0, 0, 0]); let count = 0; const totalRgb = [0, 0, 0];
    for (const [start, length] of mask.runs) for (let i = start; i < start + length; i++) {
      if (mask.kind !== 'background') sourceInk[i] = true;
      const color = [0, 1, 2].map(k => fixture.image.data[i * 4 + k]); count++; color.forEach((v, k) => totalRgb[k] += v);
      const x0 = i % width * scale + dx, y0 = Math.floor(i / width) * scale + dy;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(pattern.height, Math.ceil(y0 + scale)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(pattern.width, Math.ceil(x0 + scale)); x++) {
        const at = y * pattern.width + x, weight = Math.max(0, Math.min(x + 1, x0 + scale) - Math.max(x, x0)) * Math.max(0, Math.min(y + 1, y0 + scale) - Math.max(y, y0));
        mass[at] += weight; color.forEach((v, k) => rgb[at][k] += v * weight); roi[at] = true;
      }
    }
    return { kind: mask.kind, mass, labs: rgb.map((rgb, i) => linearToOklab(srgb8ToLinear(rgb.map(v => mass[i] ? v / mass[i] : 0) as [number, number, number]))),
      global: linearToOklab(srgb8ToLinear(totalRgb.map(v => v / Math.max(1, count)) as [number, number, number])) };
  });
  const colors = prepareColors(pattern.paletteSnapshot.colors), byId = new Map(colors.map(c => [c.id, c.oklab])), background = roles.find(r => r.kind === 'background')!;
  const fg = roles.filter(r => r.kind !== 'background');
  const accepts = (lab: typeof background.global, target: typeof background.global, compareBg: boolean) => {
    const minimum = Math.min(...colors.map(c => oklabDistance(c.oklab, target))), distance = oklabDistance(lab, target);
    return distance <= Math.max(.1, minimum + .025) && (!compareBg || distance < .6 * oklabDistance(lab, background.global));
  };
  let fgMass = 0, fgRecall = 0, bgMass = 0, bgRecall = 0, outside = 0;
  const painted = pattern.cells.map((id, i) => roi[i] && id !== null && fg.some(role => accepts(byId.get(id)!, role.global, true)));
  for (let i = 0; i < size; i++) {
    const lab = pattern.cells[i] === null ? null : byId.get(pattern.cells[i]!)!;
    let supported = 0;
    for (const role of fg) { fgMass += role.mass[i]; supported += role.mass[i]; if (lab && role.mass[i] && accepts(lab, role.labs[i], true)) fgRecall += role.mass[i]; }
    bgMass += background.mass[i]; if (lab && background.mass[i] && accepts(lab, background.labs[i], false)) bgRecall += background.mass[i];
    if (painted[i] && supported + 1e-12 < .04) outside++;
  }
  const sourceComponents = components(sourceInk, width, true).length, targetComponents = components(painted, pattern.width, true).length;
  const holeCount = (ink: boolean[], width: number) => components(ink.map(v => !v), width, false).filter(group => !group.some(i => i % width === 0 || i % width === width - 1 || i < width || i >= ink.length - width)).length;
  const sourceHoles = holeCount(sourceInk, width), targetHoles = holeCount(painted, pattern.width);
  let landmarks = 0, missingLandmarks = 0;
  for (const stroke of fixture.sourceLabels.strokes) {
    const first = stroke.points[0], last = stroke.points[stroke.points.length - 1]; if (first[0] === last[0] && first[1] === last[1]) continue;
    for (const [x, y] of [first, last]) {
      landmarks++;
      const gx = x * scale + dx, gy = y * scale + dy;
      if (!painted.some((v, i) => v && Math.hypot(i % pattern.width + .5 - gx, Math.floor(i / pattern.width) + .5 - gy) <= .8)) missingLandmarks++;
    }
  }
  return { foregroundMassRecall: fgRecall / fgMass, backgroundMassRecall: bgRecall / bgMass, unsupportedForegroundCells: outside,
    sourceComponents, targetComponents, componentCountError: Math.abs(sourceComponents - targetComponents), sourceHoles, targetHoles, holeCountError: Math.abs(sourceHoles - targetHoles), landmarks, missingLandmarks };
}

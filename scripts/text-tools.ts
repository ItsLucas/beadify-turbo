import { spawnSync } from 'node:child_process';
import type { BeadPattern, RgbaImage } from '../src/beadify/contracts';
import { rgbaToPng } from '../benchmark/synthetic';

export function decodeTextImage(file: string): RgbaImage {
  const program = "import sys,json,base64\nfrom PIL import Image,ImageOps\nim=Image.open(sys.argv[1])\nassert im.width<=4096 and im.height<=4096 and im.width*im.height<=4194304\nim=ImageOps.exif_transpose(im).convert('RGBA')\nprint(json.dumps({'width':im.width,'height':im.height,'data':base64.b64encode(im.tobytes()).decode()}))";
  const result = spawnSync('python3', ['-c', program, file], { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Image decode failed: ${result.stderr}`);
  const value = JSON.parse(result.stdout); return { width: value.width, height: value.height, data: new Uint8ClampedArray(Buffer.from(value.data, 'base64')) };
}
export function textPatternPng(pattern: BeadPattern): Buffer {
  const rgba = new Uint8ClampedArray(pattern.width * pattern.height * 4), colors = new Map(pattern.paletteSnapshot.colors.map(c => [c.id, c.srgb8]));
  pattern.cells.forEach((id, i) => { if (id) rgba.set([...colors.get(id)!, 255], i * 4); });
  return rgbaToPng(pattern.width, pattern.height, rgba);
}
export function characterErrors(reference: string, hypothesis: string) {
  const ref = Array.from(reference.normalize('NFC')), hyp = Array.from(hypothesis.normalize('NFC'));
  const rows = Array.from({ length: ref.length + 1 }, (_, i) => Array.from({ length: hyp.length + 1 }, (_, j) => !i ? j : !j ? i : 0));
  for (let i = 1; i <= ref.length; i++) for (let j = 1; j <= hyp.length; j++) rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(ref[i - 1] !== hyp[j - 1]));
  return { errors: rows[ref.length][hyp.length], referenceCharacters: ref.length, cer: ref.length ? rows[ref.length][hyp.length] / ref.length : null };
}
/** Exact polygon intersection against the frozen rectangular source labels. */
export function sourceRegionIoU(a: number[][], rectangle: number[][]): number {
  const area = (p: number[][]) => Math.abs(p.reduce((sum, v, i) => { const w = p[(i + 1) % p.length]; return sum + v[0] * w[1] - v[1] * w[0]; }, 0)) / 2;
  const left = Math.min(...rectangle.map(p => p[0])), right = Math.max(...rectangle.map(p => p[0])), top = Math.min(...rectangle.map(p => p[1])), bottom = Math.max(...rectangle.map(p => p[1]));
  let clipped = a.map(p => [...p]);
  for (const [axis, bound, direction] of [[0, left, 1], [0, right, -1], [1, top, 1], [1, bottom, -1]]) {
    const output: number[][] = [];
    for (let i = 0; i < clipped.length; i++) {
      const p = clipped[i], q = clipped[(i + 1) % clipped.length], pi = direction * (p[axis] - bound) >= 0, qi = direction * (q[axis] - bound) >= 0;
      if (pi) output.push(p);
      if (pi !== qi) { const t = (bound - p[axis]) / (q[axis] - p[axis]); output.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    clipped = output;
  }
  const intersection = area(clipped), union = area(a) + area(rectangle) - intersection;
  return union ? intersection / union : 0;
}
/** Hungarian maximum total IoU assignment with dummy unmatched columns. */
export function matchTextRegions(truth: { id: string; polygon: number[][] }[], detected: { id: string; polygon: number[][] }[]) {
  const n = truth.length, m = detected.length + n, u = Array(n + 1).fill(0), v = Array(m + 1).fill(0), p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
  const weights = truth.map(t => detected.map(d => { const iou = sourceRegionIoU(d.polygon, t.polygon); return iou >= .5 ? iou : 0; }));
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const min = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = -(weights[i0 - 1][j - 1] ?? 0) - u[i0] - v[j];
        if (cur < min[j]) { min[j] = cur; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else min[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  return Array.from({ length: n }, (_, i) => {
    const column = p.findIndex((row, index) => index > 0 && row === i + 1) - 1, weight = weights[i][column] ?? 0;
    return { truthId: truth[i].id, detectedId: weight ? detected[column].id : null, iou: weight };
  });
}

import type { BeadPattern, GenerationRequest, TextAnalysis } from './contracts';
import { hashJson } from './core/hash';
import { inspectCells, inspectConnectivity } from './core/grid';
import { validatePattern } from './core/validation';
import { textPointInside } from './core/text-extraction';
import { transformTextPoint } from './core/text-analysis';
import { rebuildTextBackground, type RetypeBackgroundMode } from './core/text-background';

export type TextRetype = {
  regionId: string; sourceRgbaHash: string; text: string;
  font: 'sans' | 'serif' | 'mono'; bold: boolean; align: 'left' | 'center' | 'right';
  foreground: string; background: string;
  backgroundMode?: RetypeBackgroundMode;
};
export const RETYPE_FONTS = {
  sans: '"Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif',
  serif: '"Noto Serif CJK SC", "Songti SC", SimSun, serif',
  mono: '"Sarasa Mono SC", "Noto Sans Mono CJK SC", monospace',
};
export function validateTextRetype(input: unknown): asserts input is TextRetype {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid text layout');
  const v = input as Record<string, unknown>;
  const keys = ['regionId', 'sourceRgbaHash', 'text', 'font', 'bold', 'align', 'foreground', 'background'];
  if (keys.some(key => !(key in v)) || Object.keys(v).some(key => ![...keys, 'backgroundMode'].includes(key))) throw new Error('Invalid text layout fields');
  if (v.backgroundMode !== undefined && !['surrounding', 'blend-color'].includes(v.backgroundMode as string)) throw new Error('Invalid text background mode');
  if (typeof v.regionId !== 'string' || !v.regionId || v.regionId.length > 128 || typeof v.sourceRgbaHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.sourceRgbaHash)) throw new Error('Invalid text layout source');
  if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > 512 || v.text.split('\n').length > 32) throw new Error('重排文字须为 1–512 字符，最多 32 行');
  if (!['sans', 'serif', 'mono'].includes(v.font as string) || !['left', 'center', 'right'].includes(v.align as string) || typeof v.bold !== 'boolean') throw new Error('Invalid text layout font');
  if (['foreground', 'background'].some(key => typeof v[key] !== 'string' || !(v[key] as string).length || (v[key] as string).length > 256) || v.backgroundMode === 'blend-color' && v.foreground === v.background) throw new Error('文字色和底色须为不同的有效色号');
}

/** Explicit typography edit: glyphs come from the chosen font, never masquerade
 * as original-source evidence. Final grid pixels are persisted in the layer. */
export async function retypeTextPattern(base: BeadPattern, analysis: TextAnalysis, layout: TextRetype, request: GenerationRequest) {
  validateTextRetype(layout); validatePattern(base);
  if (layout.sourceRgbaHash !== analysis.source.rgbaHash) throw new Error('重排记录不属于当前原图');
  const region = analysis.regions.find(r => r.id === layout.regionId);
  if (!region || !base.geometry) throw new Error('请先选择原图文字区域');
  const allowed = new Set(request.allowedColors ?? base.paletteSnapshot.colors.map(c => c.id));
  const backgroundMode = layout.backgroundMode ?? 'surrounding';
  if (!(backgroundMode === 'blend-color' ? [layout.foreground, layout.background] : [layout.foreground]).every(id => allowed.has(id) && base.paletteSnapshot.colors.some(c => c.id === id))) throw new Error('重排颜色不在当前允许色卡内');
  const polygon = region.polygon.map(point => transformTextPoint(base.geometry!.sourceToGrid, point));
  const minX = Math.min(...polygon.map(p => p[0])), minY = Math.min(...polygon.map(p => p[1]));
  const maxX = Math.max(...polygon.map(p => p[0])), maxY = Math.max(...polygon.map(p => p[1]));
  // Preserve the orientation of quadrilateral OCR regions; manual/other polygons
  // use their existing axis-aligned container and are clipped to that polygon.
  const origin = polygon.length === 4 ? polygon[0] : [minX, minY];
  const xEnd = polygon.length === 4 ? polygon[1] : [maxX, minY];
  const yEnd = polygon.length === 4 ? polygon[3] : [minX, maxY];
  const width = Math.hypot(xEnd[0] - origin[0], xEnd[1] - origin[1]);
  const height = Math.hypot(yEnd[0] - origin[0], yEnd[1] - origin[1]);
  if (width < 1 || height < 1) throw new Error('文字区域小于一格，请增大图纸尺寸');
  const canvas = document.createElement('canvas'); canvas.width = base.width * 4; canvas.height = base.height * 4;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建文字画布');
  await document.fonts.load(`${layout.bold ? 700 : 400} 32px ${RETYPE_FONTS[layout.font]}`, layout.text);
  const lines = layout.text.split('\n'), weight = layout.bold ? 700 : 400;
  let size = Math.max(.5, height / Math.max(1, lines.length * 1.2));
  for (let iteration = 0; iteration < 100; iteration++) {
    ctx.font = `${weight} ${size}px ${RETYPE_FONTS[layout.font]}`;
    if (Math.max(...lines.map(line => ctx.measureText(line).width)) <= width * .94) break;
    size *= .94;
  }
  ctx.scale(4, 4);
  ctx.beginPath(); polygon.forEach(([x, y], i) => { if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.clip();
  ctx.transform((xEnd[0] - origin[0]) / width, (xEnd[1] - origin[1]) / width, (yEnd[0] - origin[0]) / height, (yEnd[1] - origin[1]) / height, origin[0], origin[1]);
  ctx.fillStyle = '#ffffff'; ctx.font = `${weight} ${size}px ${RETYPE_FONTS[layout.font]}`; ctx.textAlign = layout.align; ctx.textBaseline = 'alphabetic';
  const blockHeight = size * 1.2 * lines.length, top = (height - blockHeight) / 2;
  const x = layout.align === 'left' ? width * .03 : layout.align === 'right' ? width * .97 : width / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, top + size * (i * 1.2 + .96)));
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const background = rebuildTextBackground(base, analysis, region.id, backgroundMode, layout.background);
  const cells = background.cells, writableCells: number[] = [];
  let inkCells = 0;
  for (let y = Math.max(0, Math.floor(minY)); y < Math.min(base.height, Math.ceil(maxY)); y++) for (let x = Math.max(0, Math.floor(minX)); x < Math.min(base.width, Math.ceil(maxX)); x++) {
    const index = y * base.width + x;
    if (cells[index] === null || !textPointInside(x + .5, y + .5, polygon)) continue;
    let alpha = 0;
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) alpha += rgba[((y * 4 + py) * canvas.width + x * 4 + px) * 4 + 3];
    const ink = alpha >= 255 * 16 * .3;
    if (ink) { cells[index] = layout.foreground; inkCells++; }
    writableCells.push(index);
  }
  if (!inkCells) throw new Error('当前区域无法表达重排文字，请增加图纸格数或减少文字');
  const colors = new Set(cells.filter((c): c is string => c !== null));
  if (colors.size > request.maxColors) throw new Error('重排后超过色数上限；请选择图纸已用颜色或增加色数');
  if (request.requiredColors?.some(color => !colors.has(color))) throw new Error('重排会移除必需色，请调整文字色或底色');
  for (const constraint of request.constraints ?? []) if (constraint.kind === 'lock-color' || constraint.kind === 'lock-empty') {
    const expected = constraint.kind === 'lock-empty' ? null : constraint.colorId;
    if (constraint.cellIndices.some(i => cells[i] !== expected)) throw new Error('文字重排与锁定格冲突');
  }
  const pattern: BeadPattern = { ...base, cells, configHash: hashJson({ engine: 'web-text-retype-v2', base: base.configHash, layout: { ...layout, backgroundMode }, cells }),
    diagnostics: { ...inspectCells(cells, base.width, base.height), ...inspectConnectivity(cells, base.width, base.height),
      colorReduction: 'none', warnings: [backgroundMode === 'surrounding' ? '文字已重新排版；原笔画位置参考周围背景修复。' : '文字已重新排版；选定底色向周围背景渐变过渡。',
        ...(background.sourceInkUsed ? [] : ['没有明确笔画标注，使用周边背景推算区域底图；请检查复杂纹理。'])] } };
  validatePattern(pattern);
  return { pattern, writableCells, changedCells: writableCells.filter(i => cells[i] !== base.cells[i]), fontSize: size, inkCells, backgroundMode, repairedCells: background.repairedCells };
}

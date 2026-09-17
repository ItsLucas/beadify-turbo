import type { Palette, RgbaImage, SceneAnalysis, SceneRegion, SourceFeatureRegion } from '../contracts';
import { hashJson, sha256 } from './hash';
import { prepareColors, srgb8ToLinear, linearToOklab, topKColors, oklabDistance } from './color';
import { validateAnalysisProvider } from './text-analysis';
import { validateSourceFeatures } from './validation';

export type SceneBox = [number, number, number, number];
export const SCENE_COLORS: Record<SceneRegion['color'], string> = { dark: '深色', light: '浅色／高光', red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', cyan: '青色', blue: '蓝色', purple: '紫色', pink: '粉色', brown: '棕色', neutral: '灰色', mixed: '多种颜色（请指定）' };
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`主体分析：${message}`); }
function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, '需要普通 JSON 对象');
  check(Object.keys(value).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(value, key)), '字段不完整或包含未知字段');
}
export function validateSceneBox(box: unknown, width: number, height: number): asserts box is SceneBox {
  check(Array.isArray(box) && box.length === 4 && box.every(Number.isSafeInteger) && box[0] >= 0 && box[1] >= 0 && box[2] <= width && box[3] <= height && box[0] < box[2] && box[1] < box[3], '建议框超出原图或范围为空');
}
export function validateSceneAnalysis(value: unknown): asserts value is SceneAnalysis {
  object(value, ['schemaVersion', 'kind', 'sourceHash', 'sourceWidth', 'sourceHeight', 'roi', 'goal', 'summary', 'provider', 'regions', 'contentHash']);
  check(value.schemaVersion === 1 && value.kind === 'scene-analysis', '不支持的版本');
  check(typeof value.sourceHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.sourceHash), '原图标识无效');
  check(typeof value.sourceWidth === 'number' && typeof value.sourceHeight === 'number' && Number.isSafeInteger(value.sourceWidth) && Number.isSafeInteger(value.sourceHeight) && value.sourceWidth > 0 && value.sourceHeight > 0 && value.sourceWidth <= 4096 && value.sourceHeight <= 4096 && value.sourceWidth * value.sourceHeight <= 4194304, '原图尺寸无效');
  validateSceneBox(value.roi, value.sourceWidth, value.sourceHeight);
  check(typeof value.goal === 'string' && value.goal.trim().length > 0 && value.goal.length <= 256 && typeof value.summary === 'string' && value.summary.length <= 512, '目标或摘要过长');
  validateAnalysisProvider(value.provider);
  check(Array.isArray(value.regions) && value.regions.length <= 12, '最多 12 个建议区域');
  const ids = new Set();
  for (const region of value.regions) {
    object(region, ['id', 'label', 'kind', 'box', 'color', 'importance']);
    check(typeof region.id === 'string' && !!region.id.trim() && region.id.length <= 128 && !ids.has(region.id), '重复或无效的区域标识'); ids.add(region.id);
    check(typeof region.label === 'string' && !!region.label.trim() && region.label.length <= 128, '区域名称无效');
    check(['subject', 'detail', 'accessory'].includes(region.kind as string) && ['normal', 'high'].includes(region.importance as string) && typeof region.color === 'string' && Object.prototype.hasOwnProperty.call(SCENE_COLORS, region.color), '区域分类无效');
    validateSceneBox(region.box, value.sourceWidth, value.sourceHeight);
    check(region.box[0] >= value.roi[0] && region.box[1] >= value.roi[1] && region.box[2] <= value.roi[2] && region.box[3] <= value.roi[3], '建议框超出分析范围');
  }
  const { contentHash, ...draft } = value;
  check(contentHash === hashJson(draft), '分析记录校验失败');
  check(JSON.stringify(value).length <= 32768, '分析记录过大');
}
export function createSceneAnalysis(draft: Omit<SceneAnalysis, 'contentHash'>): SceneAnalysis {
  const value = { ...draft, contentHash: hashJson(draft) }; validateSceneAnalysis(value); return value;
}
export function matchingScene(value: SceneAnalysis, image: RgbaImage, hash = sha256(image.data)): boolean {
  return value.sourceHash === hash && value.sourceWidth === image.width && value.sourceHeight === image.height;
}

/** Broad color classes select source pixels only. They are not segmentation or model-generated colors. */
function matchesColor(rgb: [number, number, number], color: SceneRegion['color']): boolean {
  const [r, g, b] = rgb.map(x => x / 255), hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo;
  if (color === 'dark') return hi < .48;
  if (color === 'light') return lo > .64 && delta < .22;
  if (color === 'neutral') return delta < .13 && hi >= .25 && hi <= .85;
  if (delta < .12 || hi < .18) return false;
  const h = ((hi === r ? (g - b) / delta : hi === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  if (color === 'brown') return h >= 5 && h < 65 && hi < .7;
  if (color === 'pink') return (h >= 310 || h < 15) && lo > .25;
  const ranges = { red: [345, 20], orange: [20, 45], yellow: [45, 75], green: [75, 165], cyan: [165, 200], blue: [200, 265], purple: [265, 345] };
  const range = ranges[color as keyof typeof ranges];
  return !!range && (range[0] > range[1] ? h >= range[0] || h < range[1] : h >= range[0] && h < range[1]);
}

/** The user reviews this preview before its original-pixel RLE enters the shared optimizer. */
export function sceneFeature(image: RgbaImage, analysis: SceneAnalysis, region: SceneRegion, palette: Palette, minCells = 1): { feature: SourceFeatureRegion; pixels: number } {
  validateSceneAnalysis(analysis); check(matchingScene(analysis, image), '记录不属于当前原图');
  validateSceneBox(region.box, image.width, image.height);
  check(region.color !== 'mixed', '请先选择要保留的颜色，再检查原图像素预览');
  const bins = new Map<number, { count: number; sums: number[] }>();
  const [left, top, right, bottom] = region.box;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * image.width + x) * 4, rgb: [number, number, number] = [image.data[i], image.data[i + 1], image.data[i + 2]];
    if (image.data[i + 3] < 128 || !matchesColor(rgb, region.color)) continue;
    const key = (rgb[0] >> 4) * 256 + (rgb[1] >> 4) * 16 + (rgb[2] >> 4), bin = bins.get(key) ?? { count: 0, sums: [0, 0, 0] };
    bin.count++; rgb.forEach((v, c) => bin.sums[c] += v); bins.set(key, bin);
  }
  const mode = [...bins.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0])[0]?.[1];
  check(mode, '框内没有足够的对应颜色像素，请修改建议框或颜色');
  const sourceRgb = mode.sums.map(v => v / mode.count) as [number, number, number];
  const sourceLab = linearToOklab(srgb8ToLinear(sourceRgb));
  const candidates = topKColors(sourceLab, prepareColors(palette.colors), 3);
  check(candidates.length, '没有可用的色卡颜色');
  const nearest = candidates[0];
  const chosen = palette.colors.find(c => c.id === nearest.colorId)!;
  check(oklabDistance(sourceLab, linearToOklab(srgb8ToLinear(chosen.srgb8))) <= .14, '允许色卡中没有接近该细节的颜色，请调整允许色号');
  const runs: [number, number][] = []; let pixels = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const index = y * image.width + x, offset = index * 4;
    const rgb: [number, number, number] = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    if (image.data[offset + 3] < 128 || !matchesColor(rgb, region.color) || oklabDistance(sourceLab, linearToOklab(srgb8ToLinear(rgb))) > .09) continue;
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === index) last[1]++; else runs.push([index, 1]);
    pixels++;
  }
  check(pixels > 0 && runs.length <= 262144, '原图证据为空或过于复杂，请缩小区域');
  const feature: SourceFeatureRegion = { id: `scene-${analysis.contentHash.slice(7, 23)}-${region.id}`, label: region.label,
    mask: { width: image.width, height: image.height, runs }, colorIds: [nearest.colorId], minCells,
    importance: region.importance === 'high' ? 1.5 : 1, confidence: 1, allowSingleton: true };
  validateSourceFeatures([feature], image.width, image.height, new Set(palette.colors.map(c => c.id)));
  return { feature, pixels };
}

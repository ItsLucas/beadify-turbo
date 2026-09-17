import type { Palette, TextAnalysis } from './contracts';
import type { TextRetype } from './text-retype';
type Props = { analysis?: TextAnalysis; palette: Palette; saved?: TextRetype; disabled: boolean; onGenerate(layout: TextRetype): void };
export default function TextRetypeEditor({ analysis, palette, saved, disabled, onGenerate }: Props) {
  const [regionId, setRegionId] = React.useState('');
  const [text, setText] = React.useState('');
  const [font, setFont] = React.useState<TextRetype['font']>(saved?.font ?? 'sans');
  const [bold, setBold] = React.useState(saved?.bold ?? true);
  const [align, setAlign] = React.useState<TextRetype['align']>(saved?.align ?? 'center');
  const sorted = [...palette.colors].sort((a, b) => a.srgb8.reduce((sum, v) => sum + v, 0) - b.srgb8.reduce((sum, v) => sum + v, 0));
  const [foreground, setForeground] = React.useState(saved?.foreground ?? sorted[0].id);
  const [background, setBackground] = React.useState(saved?.background ?? sorted[sorted.length - 1].id);
  const [backgroundMode, setBackgroundMode] = React.useState<NonNullable<TextRetype['backgroundMode']>>(saved?.backgroundMode ?? 'surrounding');
  React.useEffect(() => { setBackgroundMode(saved?.backgroundMode ?? 'surrounding'); }, [saved, analysis?.source.rgbaHash]);
  const selected = analysis?.regions.find(r => r.id === regionId);
  React.useEffect(() => {
    if (analysis && !analysis.regions.some(r => r.id === regionId)) setRegionId(saved?.sourceRgbaHash === analysis.source.rgbaHash && analysis.regions.some(r => r.id === saved.regionId) ? saved.regionId : analysis.regions.find(r => r.parentId === null)?.id ?? '');
  }, [analysis, regionId, saved]);
  React.useEffect(() => {
    if (!selected) return;
    setText(saved?.sourceRgbaHash === analysis?.source.rgbaHash && saved?.regionId === selected.id ? saved.text : analysis?.corrections.find(c => c.regionId === selected.id)?.transcription ?? selected.transcription);
  }, [regionId, analysis?.contentHash, saved]);
  if (!analysis?.regions.length) return null;
  return <details className="beadify-advanced" open data-testid="text-retype-panel"><summary>重新排字</summary>
    <p className="beadify-hint">保留原区域位置，自动适配字号。默认参考周围背景修复旧笔画，保留已有背景和渐变，再重绘文字；区域外与普通候选一致。</p>
    <fieldset disabled={disabled}>
      <label>文字区域<select aria-label="Retype region" value={regionId} onChange={e => setRegionId(e.target.value)}>{analysis.regions.map(r => <option key={r.id} value={r.id}>{r.parentId ? '字符 · ' : ''}{r.transcription || r.id}</option>)}</select></label>
      <label>重排内容（可换行）<textarea aria-label="Retype content" value={text} maxLength={512} rows={3} onChange={e => setText(e.target.value)} /></label>
      <label>字体<select aria-label="Retype font" value={font} onChange={e => setFont(e.target.value as typeof font)}><option value="sans">黑体 / 无衬线</option><option value="serif">宋体 / 衬线</option><option value="mono">等宽字体</option></select></label>
      <label><span>加粗</span><input aria-label="Retype bold" type="checkbox" checked={bold} onChange={e => setBold(e.target.checked)} /></label>
      <label>对齐<select aria-label="Retype alignment" value={align} onChange={e => setAlign(e.target.value as typeof align)}><option value="center">居中</option><option value="left">左对齐</option><option value="right">右对齐</option></select></label>
      <label>文字色<select aria-label="Retype foreground" value={foreground} onChange={e => setForeground(e.target.value)}>{palette.colors.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}</select></label>
      <label>背景处理<select aria-label="Retype background mode" value={backgroundMode} onChange={e => setBackgroundMode(e.target.value as typeof backgroundMode)}><option value="surrounding">衔接周围背景（推荐）</option><option value="blend-color">手选底色，边缘渐变过渡</option></select></label>
      {backgroundMode === 'blend-color' && <label>区域底色<select aria-label="Retype background" value={background} onChange={e => setBackground(e.target.value)}>{palette.colors.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}</select></label>}
      <button disabled={!text.trim() || !selected} onClick={() => onGenerate({ regionId, sourceRgbaHash: analysis.source.rgbaHash, text, font, bold, align, foreground, background, backgroundMode })}>生成重新排字候选</button>
    </fieldset>
    <p className="beadify-hint">复杂纹理请检查预览；可用笔画和背景标注缩小修复范围。保存的是实际豆格，重开不依赖字体重新渲染。</p>
  </details>;
}

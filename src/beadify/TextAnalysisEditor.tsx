import type { RgbaImage, TextAnalysis, TextEvidence } from './contracts';
import { validateTextAnalysis } from './core/text-analysis';
import { sha256 } from './core/hash';
import { maskRuns, textPointInside } from './core/text-extraction';
import { emptyTextAnalysis, matchingText, resealText, updateTextRegion } from './text-web';

type Props = { image: RgbaImage | null; value?: TextAnalysis; disabled: boolean; onChange(value: TextAnalysis | undefined): void; onGenerate(): void };
const roles = { text: '文字', logo: '标志', watermark: '水印', artwork: '图案', unknown: '不确定' };
const statuses: Record<string, string> = { verified: '已确认', unverified: '待检查', unknown: '不确定' };
export default function TextAnalysisEditor({ image, value, disabled, onChange, onGenerate }: Props) {
  const canvas = React.useRef<HTMLCanvasElement>(null), upload = React.useRef<HTMLInputElement>(null);
  const [message, setMessage] = React.useState('可手动框选文字、输入内容或导入已有记录；全部在当前浏览器处理。');
  const [selected, setSelected] = React.useState('');
  const [mode, setMode] = React.useState<'region' | TextEvidence['kind']>('region');
  const [brush, setBrush] = React.useState(3);
  const gesture = React.useRef<{ start: [number, number]; last: [number, number]; pixels: Set<number> } | null>(null);
  const hash = React.useMemo(() => image ? sha256(image.data) : '', [image]);
  const matches = !!image && !!value && matchingText(value, image, hash);
  const active = matches ? value : undefined;
  const selectedRegion = active?.regions.find(r => r.id === selected);
  React.useEffect(() => { gesture.current = null; }, [image, value]);
  React.useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !image) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    for (const evidence of active?.evidence ?? []) {
      ctx.fillStyle = evidence.kind === 'background' ? '#22c55e66' : '#c026d388';
      for (const [start, length] of evidence.runs) {
        let i = start;
        while (i < start + length) { const count = Math.min(start + length - i, image.width - i % image.width); ctx.fillRect(i % image.width, Math.floor(i / image.width), count, 1); i += count; }
      }
    }
    for (const region of active?.regions ?? []) {
      ctx.strokeStyle = region.id === selected ? '#ef4444' : region.parentId ? '#f59e0b' : '#2563eb';
      ctx.lineWidth = Math.max(1, image.width / 300) * (region.id === selected ? 2 : 1);
      ctx.beginPath(); region.polygon.forEach(([x, y], i) => { if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke();
    }
  }, [image, active, selected]);
  function commit(next: TextAnalysis) {
    try { const sealed = resealText(next); onChange(sealed); setMessage('分析记录已保存；修改网格尺寸和色数可复用。'); }
    catch (error) { setMessage(String(error)); }
  }
  function point(event: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const box = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(image!.width, Math.round((event.clientX - box.left) / box.width * image!.width))), Math.max(0, Math.min(image!.height, Math.round((event.clientY - box.top) / box.height * image!.height)))];
  }
  function paint(next: [number, number]) {
    const current = gesture.current;
    if (!current || !image || mode === 'region' || !selectedRegion) return;
    const distance = Math.max(1, Math.ceil(Math.hypot(next[0] - current.last[0], next[1] - current.last[1])));
    const ctx = canvas.current?.getContext('2d');
    if (ctx) ctx.fillStyle = mode === 'background' ? '#22c55e99' : '#c026d399';
    for (let step = 0; step <= distance; step++) {
      const x = current.last[0] + (next[0] - current.last[0]) * step / distance, y = current.last[1] + (next[1] - current.last[1]) * step / distance;
      for (let py = Math.max(0, Math.floor(y - brush)); py < Math.min(image.height, y + brush); py++) for (let px = Math.max(0, Math.floor(x - brush)); px < Math.min(image.width, x + brush); px++) {
        if (Math.hypot(px + .5 - x, py + .5 - y) > brush || !textPointInside(px + .5, py + .5, selectedRegion.polygon)) continue;
        current.pixels.add(py * image.width + px); ctx?.fillRect(px, py, 1, 1);
      }
    }
    current.last = next;
  }
  function finish(event: React.PointerEvent<HTMLCanvasElement>) {
    const current = gesture.current;
    if (!current || !image) return;
    const end = point(event); paint(end); gesture.current = null;
    const next = active ?? emptyTextAnalysis(image);
    if (mode === 'region') {
      const [left, right] = [current.start[0], end[0]].sort((a, b) => a - b), [top, bottom] = [current.start[1], end[1]].sort((a, b) => a - b);
      if (right - left < 2 || bottom - top < 2) return;
      const id = `manual-${Date.now()}`;
      commit({ ...next, regions: [...next.regions, { id, parentId: null, polygon: [[left, top], [right, top], [right, bottom], [left, bottom]], granularity: 'unknown', role: 'text', status: 'verified', transcription: '', detectionScore: null, recognitionScore: null, alignment: 'manual', readingOrder: null, angle: null }] });
      setSelected(id);
    } else if (selectedRegion && current.pixels.size) {
      const evidence = next.evidence.filter(e => e.regionId !== selected);
      const previous = next.evidence.filter(e => e.regionId === selected && e.origin !== 'source-extractor');
      for (const kind of ['ink', 'background', 'outline', 'shadow'] as const) {
        const pixels = new Set<number>();
        for (const e of previous.filter(e => e.kind === kind)) for (const [start, length] of e.runs) for (let i = start; i < start + length; i++) if (!current.pixels.has(i)) pixels.add(i);
        if (kind === mode) current.pixels.forEach(i => pixels.add(i));
        if (pixels.size) evidence.push({ id: `${selected}-manual-${kind}`, regionId: selected, kind, origin: 'manual', status: 'verified', runs: maskRuns([...pixels]) });
      }
      const ids = new Set(evidence.map(e => e.id));
      commit({ ...next, evidence, relations: next.relations.filter(r => r.evidenceIds.every(id => ids.has(id))) });
    }
  }
  async function importRecord(file: File) {
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('分析记录超过 2 MiB');
      const next: unknown = JSON.parse(await file.text()); validateTextAnalysis(next);
      if (image && !matchingText(next, image, hash)) throw new Error('记录不属于当前原图；请选择匹配的原图。');
      onChange(next); setMessage('分析记录已导入。');
    } catch (error) { setMessage(String(error)); }
  }
  function exportRecord() {
    if (!value) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'text-analysis.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="beadify-advanced text-analysis-panel" open data-testid="text-analysis-panel">
    <summary>手工文字标注</summary>
    <p className="beadify-hint">原字形增强保留原图字体、布局和颜色。也可在下方“重新排字”中用校正后的文字重绘。文字候选以结构优化为基础。</p>
    <div className="beadify-actions">
      <button onClick={() => upload.current?.click()}>导入文字分析</button>
      <button onClick={exportRecord} disabled={!value}>导出文字分析</button>
    </div>
    <input ref={upload} aria-label="Import text analysis" type="file" accept=".json,application/json" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importRecord(file); e.target.value = ''; }} />
    <p role="status" data-testid="text-analysis-status">{message}</p>
    {value && !matches && <p className="beadify-risk">已保存的分析属于另一张或尚未加载的原图；重新选择匹配原图可继续增强。</p>}
    {image && <>
      <label>原图标注<select aria-label="Text annotation tool" value={mode} disabled={disabled} onChange={e => setMode(e.target.value as typeof mode)}>
        <option value="region">拖动框选文字区域</option><option value="ink">涂抹文字笔画</option><option value="background">涂抹区域背景</option><option value="outline">涂抹描边</option><option value="shadow">涂抹阴影</option>
      </select></label>
      {mode !== 'region' && <label>画笔半径（原图像素）<input aria-label="Text evidence brush radius" type="number" min={1} max={24} value={brush} onChange={e => setBrush(Math.max(1, Math.min(24, Number(e.target.value) || 1)))} /></label>}
      <canvas ref={canvas} width={image.width} height={image.height} aria-label="原图文字区域标注" className="text-analysis-canvas"
        onPointerDown={e => { if (disabled || mode !== 'region' && !selectedRegion) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); const start = point(e); gesture.current = { start, last: start, pixels: new Set() }; paint(start); }}
        onPointerMove={e => paint(point(e))} onPointerUp={finish} onPointerCancel={() => { gesture.current = null; }} />
      <p className="beadify-hint">框选时留少量背景边缘。手涂时先选区域，分别标注笔画和背景；紫色为笔画，绿色为背景。</p>
    </>}
    {!!value?.regions.length && <div className="text-region-list">
      {value.regions.map(region => <div className="text-region" key={region.id}>
        <button aria-pressed={selected === region.id} onClick={() => setSelected(region.id)}>{region.parentId ? '↳ ' : ''}{region.transcription || '未填写文字'} · {statuses[region.status]}</button>
        <select aria-label={`Region role ${region.id}`} value={region.role} disabled={disabled} onChange={e => commit(updateTextRegion(value, region.id, e.target.value as keyof typeof roles))}>
          {Object.entries(roles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <input aria-label={`Correct text ${region.id}`} maxLength={512} placeholder="输入或校正文字内容" value={value.corrections.find(c => c.regionId === region.id)?.transcription ?? region.transcription} disabled={disabled}
          onChange={e => commit({ ...value, corrections: [...value.corrections.filter(c => c.regionId !== region.id), { regionId: region.id, transcription: e.target.value, origin: 'manual' }] })} />
        <button disabled={disabled} onClick={() => commit(updateTextRegion(value, region.id, 'delete'))}>移除区域</button>
      </div>)}
    </div>}
    <div className="beadify-actions"><button onClick={onGenerate} disabled={!matches || !active?.regions.length || disabled}>比较普通与文字增强</button>
      <button onClick={() => { onChange(undefined); }} disabled={!value || disabled}>清除分析记录</button></div>
  </details>;
}

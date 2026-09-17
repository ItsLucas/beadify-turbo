import type { Palette, RgbaImage, SourceFeatureRegion } from './contracts';
import { parseColorCodes } from './workspace-generation';

type Rect = [number, number, number, number];
type Props = {
  image: RgbaImage;
  palette: Palette;
  value: SourceFeatureRegion[];
  selectedColorId: string;
  onChange: (regions: SourceFeatureRegion[]) => void;
  disabled?: boolean;
};

/** Manual annotations stay in the original image frame, before crop and sampling. */
export default function SourceFeatureEditor({ image, palette, value, selectedColorId, onChange, disabled = false }: Props) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const start = React.useRef<[number, number] | null>(null);
  const editedRect = React.useRef<Rect | null>(null);
  const [rect, setRect] = React.useState<Rect>([0, 0, image.width, image.height]);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('细节');
  const [colors, setColors] = React.useState('');
  const [minCells, setMinCells] = React.useState(1);
  const [importance, setImportance] = React.useState(1);
  const [allowSingleton, setAllowSingleton] = React.useState(true);
  const [error, setError] = React.useState('');
  const [history, setHistory] = React.useState<SourceFeatureRegion[][]>([]);
  React.useEffect(() => { setRect([0, 0, image.width, image.height]); setEditingId(null); setError(''); setHistory([]); }, [image]);
  function commit(next: SourceFeatureRegion[]) { setHistory(previous => [...previous.slice(-11), value]); onChange(next); }
  React.useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    ctx.fillStyle = '#7e22ce66';
    for (const region of value) for (const [offset, length] of region.mask.runs) {
      // Imported runs may span rows; drawing keeps the mask in its source frame.
      let at = offset, remaining = length;
      while (remaining > 0) {
        const span = Math.min(remaining, image.width - at % image.width);
        ctx.fillRect(at % image.width, Math.floor(at / image.width), span, 1);
        at += span; remaining -= span;
      }
    }
    ctx.strokeStyle = '#e32643';
    ctx.lineWidth = Math.max(1, image.width / Math.max(1, canvas.current!.getBoundingClientRect().width));
    ctx.strokeRect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
  }, [image, value, rect]);
  function point(event: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const box = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(image.width - 1, Math.floor((event.clientX - box.left) / box.width * image.width))), Math.max(0, Math.min(image.height - 1, Math.floor((event.clientY - box.top) / box.height * image.height)))];
  }
  function select(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!start.current || disabled) return;
    const end = point(event);
    setRect([Math.min(start.current[0], end[0]), Math.min(start.current[1], end[1]), Math.max(start.current[0], end[0]) + 1, Math.max(start.current[1], end[1]) + 1]);
  }
  function edit(region: SourceFeatureRegion) {
    let left = image.width, top = image.height, right = 0, bottom = 0;
    for (const [offset, length] of region.mask.runs) {
      let at = offset, remaining = length;
      while (remaining > 0) {
        const x = at % image.width, y = Math.floor(at / image.width), span = Math.min(remaining, image.width - x);
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + span); bottom = Math.max(bottom, y + 1);
        at += span; remaining -= span;
      }
    }
    editedRect.current = [left, top, right, bottom];
    setRect(editedRect.current); setEditingId(region.id); setLabel(region.label);
    setColors(region.colorIds.join(', ')); setMinCells(region.minCells); setImportance(region.importance); setAllowSingleton(region.allowSingleton); setError('');
  }
  function save() {
    try {
      const colorIds = parseColorCodes(colors || selectedColorId, palette);
      if (!label.trim()) throw new Error('请填写特征名称。');
      if (!colorIds.length) throw new Error('请填写可接受色号，或在色卡中选一种颜色。');
      if (!Number.isSafeInteger(minCells) || minCells < 1 || minCells > 65536) throw new Error('最少保留格数须为 1–65536 的整数。');
      if (!Number.isFinite(importance) || importance < 0 || importance > 10) throw new Error('重要度须在 0–10 之间。');
      const runs: [number, number][] = [];
      for (let y = rect[1]; y < rect[3]; y++) runs.push([y * image.width + rect[0], rect[2] - rect[0]]);
      let id = editingId ?? `manual-${value.length + 1}`;
      if (!editingId) { let suffix = value.length + 1; while (value.some(region => region.id === id)) id = `manual-${++suffix}`; }
      const unchangedMask = editingId && editedRect.current?.every((value, index) => value === rect[index]) ? value.find(region => region.id === editingId)?.mask : undefined;
      const region: SourceFeatureRegion = { id, label: label.trim(), mask: unchangedMask ?? { width: image.width, height: image.height, runs }, colorIds, minCells, importance, confidence: 1, allowSingleton };
      commit(editingId ? value.map(item => item.id === editingId ? region : item) : [...value, region]);
      setEditingId(null); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <details className="beadify-source-features" data-testid="source-feature-editor">
    <summary>标记原图细节</summary>
    <p className="beadify-hint">在原图框出嘴线、眼睛或高光，再指定可接受的色号。标记随裁切和网格位置一起投影，使用结构优化生成。</p>
    <fieldset disabled={disabled}>
      <div className="beadify-subject-canvas-wrap"><canvas ref={canvas} width={image.width} height={image.height} aria-label="原图特征选区" className="beadify-subject-source"
        onPointerDown={event => { if (disabled || event.button !== 0) return; start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); select(event); }}
        onPointerMove={select} onPointerUp={event => { select(event); start.current = null; }} onPointerCancel={() => { start.current = null; }} /></div>
      <div className="beadify-selection-fields">
        {['左', '上', '右', '下'].map((name, index) => <label key={name}>{name}<input aria-label={`原图特征${name}`} type="number" value={rect[index]} min={index < 2 ? 0 : 1} max={index % 2 ? image.height : image.width} onChange={event => {
          const next = [...rect] as Rect; next[index] = Number(event.target.value);
          if (next.every(Number.isSafeInteger) && next[0] >= 0 && next[1] >= 0 && next[2] <= image.width && next[3] <= image.height && next[0] < next[2] && next[1] < next[3]) setRect(next);
        }} /></label>)}
      </div>
      <label>特征名称<input aria-label="原图特征名称" value={label} maxLength={128} onChange={event => setLabel(event.target.value)} /></label>
      <label>可接受色号<input aria-label="原图特征色号" value={colors} placeholder="留空使用当前选中色；如 H2, H7" onChange={event => setColors(event.target.value)} /></label>
      <div className="beadify-feature-fields">
        <label>最少保留格数<input aria-label="原图特征最少格数" type="number" min={1} max={65536} value={minCells} onChange={event => setMinCells(Number(event.target.value))} /></label>
        <label>重要度<input aria-label="原图特征重要度" type="number" min={0} max={10} step={0.1} value={importance} onChange={event => setImportance(Number(event.target.value))} /></label>
      </div>
      <label className="beadify-feature-checkbox"><input aria-label="原图特征允许单颗" type="checkbox" checked={allowSingleton} onChange={event => setAllowSingleton(event.target.checked)} />允许单颗细节</label>
      <div className="beadify-actions"><button type="button" onClick={save}>{editingId ? '保存原图特征' : '添加原图特征'}</button>{editingId && <button type="button" onClick={() => setEditingId(null)}>取消修改</button>}</div>
      <div className="beadify-actions"><button type="button" disabled={!history.length} onClick={() => { const previous = history[history.length - 1]; setHistory(history.slice(0, -1)); onChange(previous); setEditingId(null); }}>撤销特征修改</button><button type="button" disabled={!value.length} onClick={() => { commit([]); setEditingId(null); }}>清除原图特征</button></div>
      {value.length > 0 && <ul className="beadify-feature-list">{value.map(region => <li key={region.id}><span>{region.label} · 至少 {region.minCells} 格 · {region.colorIds.map(id => palette.colors.find(color => color.id === id)?.code ?? id).join(' / ')}</span><button type="button" aria-label={`编辑特征 ${region.label}`} onClick={() => edit(region)}>修改</button><button type="button" aria-label={`删除特征 ${region.label}`} onClick={() => { commit(value.filter(item => item.id !== region.id)); if (editingId === region.id) setEditingId(null); }}>删除</button></li>)}</ul>}
    </fieldset>
    {error && <p className="beadify-subject-error" role="alert">{error}</p>}
  </details>;
}

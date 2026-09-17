import type { PreprocessingOptions, RgbaImage } from './contracts';
import { DEFAULT_BACKGROUND_TOLERANCE, detectWhiteBorder, prepareImage } from './core/preprocess';

export type SubjectEditorProps = {
  image: RgbaImage;
  value: PreprocessingOptions;
  onChange: (options: PreprocessingOptions) => void;
  disabled?: boolean;
};
type Point = { x: number; y: number };
type SubjectTool = 'crop' | 'keep' | 'remove' | 'auto';
type Gesture = { pointerId: number; start: Point; previous: Point; options: PreprocessingOptions };

function paint(mask: number[], width: number, height: number, from: Point, to: Point, radius: number, value: number): void {
  const dx = to.x - from.x, dy = to.y - from.y, lengthSquared = dx * dx + dy * dy;
  const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius));
  const right = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + radius));
  const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + radius));
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const projection = lengthSquared ? Math.max(0, Math.min(1, ((x + 0.5 - from.x) * dx + (y + 0.5 - from.y) * dy) / lengthSquared)) : 0;
    if ((x + 0.5 - from.x - projection * dx) ** 2 + (y + 0.5 - from.y - projection * dy) ** 2 <= radius * radius) mask[y * width + x] = value;
  }
}

export default function SubjectEditor({ image, value, onChange, disabled = false }: SubjectEditorProps) {
  const sourceRef = React.useRef<HTMLCanvasElement>(null);
  const previewRef = React.useRef<HTMLCanvasElement>(null);
  const gestureRef = React.useRef<Gesture | null>(null);
  const [tool, setTool] = React.useState<SubjectTool>('crop');
  const [brushSize, setBrushSize] = React.useState(24);
  const [showMask, setShowMask] = React.useState(true);
  const [draft, setDraft] = React.useState<PreprocessingOptions | null>(null);
  const [history, setHistory] = React.useState<PreprocessingOptions[]>([]);
  const [cropError, setCropError] = React.useState('');
  const [borderTolerance, setBorderTolerance] = React.useState(0);
  const [borderNotice, setBorderNotice] = React.useState('');
  const current = draft ?? value;
  const crop = current.crop ?? [0, 0, image.width, image.height];
  const brushDiameter = Math.min(brushSize, Math.max(image.width, image.height));
  const prepared = React.useMemo(() => {
    try { return { result: prepareImage(image, value), error: '' }; }
    catch (error) { return { result: null, error: error instanceof Error ? error.message : '无法预览主体' }; }
  }, [image, value]);

  React.useEffect(() => {
    setHistory([]); setDraft(null); gestureRef.current = null; setCropError(''); setBorderNotice('');
  }, [image]);

  const commit = (options: PreprocessingOptions) => {
    // Bound retained full-size masks to roughly 32 MiB of number-array entries.
    const historyLimit = Math.max(1, Math.min(12, Math.floor(4_194_304 / (image.width * image.height))));
    setHistory(previous => [...previous, value].slice(-historyLimit));
    setDraft(null); setCropError(''); onChange(options);
  };

  React.useEffect(() => {
    const canvas = sourceRef.current, context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const bytes = new Uint8ClampedArray(image.data);
    if (showMask && current.mask) for (let pixel = 0; pixel < current.mask.length; pixel++) {
      const mark = current.mask[pixel];
      if (mark === 0) continue;
      const offset = pixel * 4;
      const tint = mark === 1 ? [24, 180, 110] : [238, 68, 68];
      for (let channel = 0; channel < 3; channel++) bytes[offset + channel] = bytes[offset + channel] * 0.5 + tint[channel] * 0.5;
      bytes[offset + 3] = Math.max(bytes[offset + 3], 180);
    }
    context.putImageData(new ImageData(bytes, image.width, image.height), 0, 0);
    const [left, top, right, bottom] = current.crop ?? [0, 0, image.width, image.height];
    context.fillStyle = 'rgba(12, 22, 28, 0.48)';
    context.fillRect(0, 0, image.width, top);
    context.fillRect(0, bottom, image.width, image.height - bottom);
    context.fillRect(0, top, left, bottom - top);
    context.fillRect(right, top, image.width - right, bottom - top);
    const scale = image.width / Math.max(1, canvas.getBoundingClientRect().width);
    context.lineWidth = Math.max(1, 2 * scale);
    context.strokeStyle = '#17656a';
    context.setLineDash([6 * scale, 3 * scale]);
    context.strokeRect(left, top, right - left, bottom - top);
    context.setLineDash([]);
  }, [image, current, showMask]);

  React.useEffect(() => {
    const context = previewRef.current?.getContext('2d'), result = prepared.result;
    if (!context || !result) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(result.image.data), result.image.width, result.image.height), 0, 0);
  }, [prepared]);

  const eventPoint = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(image.width - 0.001, (event.clientX - rect.left) * image.width / rect.width)),
      y: Math.max(0, Math.min(image.height - 0.001, (event.clientY - rect.top) * image.height / rect.height)),
    };
  };
  const updateGesture = (gesture: Gesture, point: Point) => {
    if (tool === 'crop') {
      gesture.options = { ...gesture.options, crop: [
        Math.floor(Math.min(gesture.start.x, point.x)), Math.floor(Math.min(gesture.start.y, point.y)),
        Math.min(image.width, Math.floor(Math.max(gesture.start.x, point.x)) + 1),
        Math.min(image.height, Math.floor(Math.max(gesture.start.y, point.y)) + 1),
      ] };
    } else {
      paint(gesture.options.mask!, image.width, image.height, gesture.previous, point, Math.max(1, brushDiameter) / 2,
        tool === 'keep' ? 1 : tool === 'remove' ? 2 : 0);
      gesture.options.mask![Math.floor(point.y) * image.width + Math.floor(point.x)] = tool === 'keep' ? 1 : tool === 'remove' ? 2 : 0;
      // The mask belongs solely to this uncommitted stroke; shallow-copy to redraw.
      gesture.options = { ...gesture.options };
    }
    gesture.previous = point; setDraft(gesture.options);
  };
  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || event.button !== 0 || gestureRef.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const point = eventPoint(event);
    const options: PreprocessingOptions = tool === 'crop' ? { ...value } : { ...value, mask: value.mask ? [...value.mask] : new Array<number>(image.width * image.height).fill(0) };
    const gesture: Gesture = { pointerId: event.pointerId, start: point, previous: point, options };
    gestureRef.current = gesture; updateGesture(gesture, point);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || disabled) return;
    updateGesture(gesture, eventPoint(event));
  };
  const finishGesture = (event: React.PointerEvent<HTMLCanvasElement>, cancel = false) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancel || disabled) setDraft(null);
    else { updateGesture(gesture, eventPoint(event)); commit(gesture.options); }
  };
  const changeCrop = (index: number, input: HTMLInputElement) => {
    const next = [...crop] as [number, number, number, number];
    next[index] = input.valueAsNumber;
    const [left, top, right, bottom] = next;
    if (next.some(number => !Number.isSafeInteger(number)) || left < 0 || top < 0 || right > image.width || bottom > image.height || left >= right || top >= bottom) {
      input.value = String(crop[index]); setCropError('裁切范围需在原图内，右边和下边不包含在内。'); return;
    }
    if (next[index] !== crop[index]) commit({ ...value, crop: next });
  };

  return <section className="beadify-subject-editor" aria-label="主体选择">
    <div className="beadify-subject-heading"><strong>限定主体</strong><span>裁切、去背景和涂抹共同用于所有算法</span></div>
    <fieldset disabled={disabled} className="beadify-subject-controls">
      <label>背景<select aria-label="主体背景" value={value.background ?? 'keep'} onChange={event => commit({ ...value, background: event.target.value as 'keep' | 'edge' })}>
        <option value="keep">保留原背景</option><option value="edge">去除边界连通背景</option>
      </select></label>
      {value.background === 'edge' && <label>背景容差<input aria-label="背景容差" type="range" min="0" max="255" value={value.tolerance ?? DEFAULT_BACKGROUND_TOLERANCE}
        onChange={event => commit({ ...value, tolerance: Number(event.target.value) })} /><output>{value.tolerance ?? DEFAULT_BACKGROUND_TOLERANCE}</output></label>}
      <div className="beadify-subject-tools" role="group" aria-label="主体工具">
        {([['crop', '框选裁切'], ['keep', '保留画笔'], ['remove', '删除画笔'], ['auto', '恢复自动']] as const).map(([id, label]) =>
          <button type="button" key={id} aria-pressed={tool === id} onClick={() => setTool(id)}>{label}</button>)}
      </div>
      {tool !== 'crop' && <label>画笔直径<input aria-label="主体画笔大小" type="range" min="1" max={Math.min(200, Math.max(image.width, image.height))} value={brushDiameter}
        onChange={event => setBrushSize(Number(event.target.value))} /><output>{brushDiameter} px</output></label>}
      <label className="beadify-subject-checkbox"><input type="checkbox" checked={showMask} onChange={event => setShowMask(event.target.checked)} />显示涂抹标记</label>
      <div className="beadify-subject-actions">
        <button type="button" disabled={history.length === 0} onClick={() => { const previous = history[history.length - 1]; setHistory(history.slice(0, -1)); setDraft(null); setCropError(''); onChange(previous); }}>撤销主体修改</button>
        <button type="button" onClick={() => commit({})}>重置主体</button>
      </div>
    </fieldset>
    <div className="beadify-subject-canvases">
      <figure><figcaption>原图 · {image.width} × {image.height}</figcaption>
        <div className="beadify-subject-canvas-wrap"><canvas ref={sourceRef} width={image.width} height={image.height} aria-label="主体原图编辑画布"
          className={`beadify-subject-source subject-tool-${tool}`} onPointerDown={pointerDown} onPointerMove={pointerMove}
          onPointerUp={event => finishGesture(event)} onPointerCancel={event => finishGesture(event, true)} /></div>
      </figure>
      <figure><figcaption>透明主体预览{prepared.result ? ` · ${prepared.result.image.width} × ${prepared.result.image.height}` : ''}</figcaption>
        <div className="beadify-subject-canvas-wrap">{prepared.result && <canvas ref={previewRef} width={prepared.result.image.width} height={prepared.result.image.height} aria-label="透明主体预览" />}</div>
      </figure>
    </div>
    <details className="beadify-advanced" open data-testid="white-border-editor"><summary>裁切白色边框</summary>
      <p className="beadify-subject-hint">收紧四周连续的纯白行、列，框内背景与白色高光保留。结果可预览、撤销，也可调整下方四边。</p>
      <label>白色容差（0 为纯白）<input aria-label="White border tolerance" type="number" min={0} max={32} value={borderTolerance} disabled={disabled} onChange={e => setBorderTolerance(Math.max(0, Math.min(32, Math.round(Number(e.target.value) || 0))))} /></label>
      <button disabled={disabled} onClick={() => {
        const result = detectWhiteBorder(image, value, borderTolerance);
        if (result.status === 'trimmed') { commit({ ...value, crop: result.crop }); setBorderNotice(`已裁去白边：左 ${result.removedMargins[0]}、上 ${result.removedMargins[1]}、右 ${result.removedMargins[2]}、下 ${result.removedMargins[3]} 像素。`); }
        else setBorderNotice(result.status === 'empty' ? '当前范围全是白色或透明像素，未自动改变裁切范围。' : '没有检测到连续白边，可手动调整四边。');
      }}>裁切白色边框</button>
      {borderNotice && <p role="status" className="beadify-subject-hint">{borderNotice}</p>}
    </details>
    <fieldset disabled={disabled} className="beadify-subject-crop" key={`${image.width}:${image.height}:${crop.join(',')}`}>
      {['左', '上', '右', '下'].map((label, index) => <label key={label}>{label}<input type="number" aria-label={`主体裁切${label}`} min={index < 2 ? 0 : 1}
        max={index % 2 === 0 ? image.width : image.height} step="1" defaultValue={crop[index]}
        onBlur={event => changeCrop(index, event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>)}
    </fieldset>
    {(cropError || prepared.error) && <p className="beadify-subject-error" role="alert">{cropError || prepared.error}</p>}
    <p className="beadify-subject-hint">绿色保留，红色删除；画笔作用于原图像素。白色主体和贴边细部可用保留画笔修复，链条等附件可用删除画笔去除。</p>
    {value.background === 'edge' && <p className="beadify-subject-hint">容差是与边界估计色的最大 RGB 通道差（0–255）。
      {prepared.result?.backgroundColor ? ` 本次移除 ${prepared.result.removedPixelCount.toLocaleString()} 个像素。` : ' 边界颜色不明确，已保留原有透明度，可手动涂抹。'}</p>}
  </section>;
}

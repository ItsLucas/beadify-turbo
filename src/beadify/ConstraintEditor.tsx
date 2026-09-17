import type { BeadProject } from '../types';
import type { CellConstraint, Palette } from './contracts/index';
import { projectColor } from '../project';
import { parseColorCodes } from './workspace-generation';

export function coreColorId(project: BeadProject, id: string): string {
  const snapshot = project.beadify?.paletteSnapshot.colors.find(color => color.id === id || `mard-${color.code.toLowerCase()}` === id);
  return snapshot?.id ?? `MARD:unspecified:${projectColor(project, id)?.primaryCode ?? id}`;
}

type Props = {
  project: BeadProject;
  selectedColorId: string;
  palette: Palette;
  onChange: (constraints: CellConstraint[]) => void;
  onRecalculate: (indices: number[], source: 'source' | 'pattern') => void;
  disabled?: boolean;
};

/** A small selection canvas keeps optimization annotations separate from drawing tools. */
export default function ConstraintEditor({ project, selectedColorId, palette, onChange, onRecalculate, disabled }: Props) {
  const { width, height } = project;
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const start = React.useRef<[number, number] | null>(null);
  const [rect, setRect] = React.useState<[number, number, number, number]>([0, 0, width, height]);
  const [recalculateSource, setRecalculateSource] = React.useState<'source' | 'pattern'>(project.beadify?.sourceRaster ? 'source' : 'pattern');
  const [featureColors, setFeatureColors] = React.useState('');
  const [minCells, setMinCells] = React.useState(1);
  const [allowSingleton, setAllowSingleton] = React.useState(true);
  const [showFeatureOptions, setShowFeatureOptions] = React.useState(false);
  const [error, setError] = React.useState('');
  React.useEffect(() => setRecalculateSource(project.beadify?.sourceRaster ? 'source' : 'pattern'), [!!project.beadify?.sourceRaster]);
  const constraints = project.beadify?.constraints ?? [];
  React.useEffect(() => setRect([0, 0, width, height]), [width, height]);
  const selection: number[] = [];
  for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0]; x < rect[2]; x++) selection.push(y * width + x);
  const selected = new Set(selection);
  React.useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width * 4, height * 4);
    project.cells.forEach((id, i) => {
      ctx.fillStyle = projectColor(project, id)?.hex ?? ((i % width + Math.floor(i / width)) % 2 ? '#eee' : '#fff');
      ctx.fillRect((i % width) * 4, Math.floor(i / width) * 4, 4, 4);
    });
    for (const constraint of constraints) {
      ctx.fillStyle = constraint.kind.startsWith('lock') ? '#1e40af88' : constraint.kind === 'simplify' ? '#eab30888' : '#7e22ce88';
      for (const i of constraint.cellIndices) ctx.fillRect((i % width) * 4, Math.floor(i / width) * 4, 4, 4);
    }
    ctx.strokeStyle = '#d92b45'; ctx.lineWidth = 1;
    ctx.strokeRect(rect[0] * 4 + .5, rect[1] * 4 + .5, (rect[2] - rect[0]) * 4 - 1, (rect[3] - rect[1]) * 4 - 1);
  }, [project, rect]);
  function point(event: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const box = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(width - 1, Math.floor((event.clientX - box.left) / box.width * width))), Math.max(0, Math.min(height - 1, Math.floor((event.clientY - box.top) / box.height * height)))];
  }
  function select(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!start.current) return;
    const end = point(event);
    setRect([Math.min(start.current[0], end[0]), Math.min(start.current[1], end[1]), Math.max(start.current[0], end[0]) + 1, Math.max(start.current[1], end[1]) + 1]);
  }
  function apply(kind: CellConstraint['kind'] | 'clear') {
    setError('');
    const retained = constraints.map(c => ({ ...c, cellIndices: c.cellIndices.filter(i => !selected.has(i)) })).filter(c => c.cellIndices.length);
    if (kind === 'lock-color') {
      const groups = new Map<string | null, number[]>();
      for (const i of selection) { const id = project.cells[i]; groups.set(id, [...(groups.get(id) ?? []), i]); }
      for (const [id, cellIndices] of groups) retained.push(id === null ? { kind: 'lock-empty', cellIndices } : { kind, cellIndices, colorId: coreColorId(project, id) });
    } else if (kind === 'feature') {
      try {
        if (!Number.isSafeInteger(minCells) || minCells < 1 || minCells > selection.length) throw new Error('最少保留格数须为正整数，且不能超过选区格数。');
        const colorIds = featureColors.trim() ? parseColorCodes(featureColors, palette) : [coreColorId(project, selectedColorId)];
        retained.push({ kind, cellIndices: selection, ...(colorIds.length === 1 ? { colorId: colorIds[0] } : { colorIds }), strength: 1,
          ...(minCells !== 1 ? { minCells } : {}), ...(!allowSingleton ? { allowSingleton: false } : {}) });
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    } else if (kind !== 'clear') {
      retained.push({ kind, cellIndices: selection });
    }
    onChange(retained);
  }
  return <details className="beadify-constraints" data-testid="constraint-editor">
    <summary>选区重算与保护</summary>
    <p className="beadify-hint">在小图拖框选择，选区外保持原样。蓝色为锁定，紫色为保护。这些规则用于重算，画笔仍可自由修改。</p>
    <label className="stacked-field">重算依据<select aria-label="重算依据" disabled={disabled} value={recalculateSource} onChange={event => setRecalculateSource(event.target.value as 'source' | 'pattern')}>
      <option value="source" disabled={!project.beadify?.sourceRaster}>原图细节重算</option><option value="pattern">整理当前图纸</option>
    </select></label>
    <p className="beadify-hint">{recalculateSource === 'source' ? '使用保存的原图细节与位置，重新打开项目后仍可用。' : '以当前图纸颜色为依据整理；已丢失的原图细节需要原图记录。'}</p>
    {project.beadify?.sourceRasterOmission && !project.beadify.sourceRaster && <p className="beadify-hint">受保存容量限制，此项目未包含原图细节记录。图纸、图层和规则均已保留；重新选择原图并生成，可恢复原图细节重算。</p>}
    {recalculateSource === 'source' && project.beadify?.sourceRaster && (project.beadify.sourceRaster.algorithmVersion ?? 3) < 5 && <p className="beadify-hint">此项目使用旧版细节记录。重新选择原图并生成一次，可启用新增的线条与形状保护。</p>}
    <canvas ref={canvas} width={width * 4} height={height * 4} aria-label="Constraint selection" style={{ width: '100%', imageRendering: 'pixelated', touchAction: 'none' }}
      onPointerDown={e => { start.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); select(e); }}
      onPointerMove={select} onPointerUp={e => { select(e); start.current = null; }} onPointerCancel={() => { start.current = null; }} />
    <div className="beadify-selection-fields">
      {(['左', '上', '右', '下'] as const).map((label, i) => <label key={i}>{label}<input type="number" aria-label={`Selection ${['left', 'top', 'right', 'bottom'][i]}`} value={rect[i]} min={i < 2 ? 0 : 1} max={i % 2 ? height : width} onChange={e => {
        const next = [...rect] as typeof rect; next[i] = Math.max(i < 2 ? 0 : 1, Math.min(i % 2 ? height : width, Math.floor(Number(e.target.value))));
        if (next[0] < next[2] && next[1] < next[3]) setRect(next);
      }} /></label>)}
    </div>
    <p>{selection.length} 格选中 · {new Set(constraints.flatMap(c => c.cellIndices)).size} 格有规则</p>
    <button type="button" className="beadify-feature-toggle" aria-expanded={showFeatureOptions} onClick={() => setShowFeatureOptions(value => !value)}>细节保留规则</button>
    {showFeatureOptions && <div className="beadify-feature-options">
      <label>可接受色号<input aria-label="选区特征色号" value={featureColors} placeholder="留空使用当前选中色" disabled={disabled} onChange={event => setFeatureColors(event.target.value)} /></label>
      <label>最少保留格数<input aria-label="选区特征最少格数" type="number" min={1} max={selection.length} value={minCells} disabled={disabled} onChange={event => setMinCells(Number(event.target.value))} /></label>
      <label className="beadify-feature-checkbox"><input aria-label="选区特征允许单颗" type="checkbox" checked={allowSingleton} disabled={disabled} onChange={event => setAllowSingleton(event.target.checked)} />允许单颗细节</label>
    </div>}
    {error && <p className="beadify-subject-error" role="alert">{error}</p>}
    <div className="beadify-actions">
      <button disabled={disabled} onClick={() => apply('lock-color')}>锁定原色</button>
      <button disabled={disabled} onClick={() => apply('lock-empty')}>锁定空格</button>
      <button disabled={disabled} onClick={() => apply('protect')}>保护细节</button>
      <button disabled={disabled} onClick={() => apply('simplify')}>简化色块</button>
      <button disabled={disabled} onClick={() => apply('feature')}>强化选中色</button>
      <button disabled={disabled} onClick={() => apply('clear')}>清除选区规则</button>
      <button disabled={disabled} onClick={() => onRecalculate(selection, recalculateSource)}>重算选区</button>
    </div>
  </details>;
}

import type { OptimizationOptions } from './contracts';
type Props = { value: OptimizationOptions; crossBin: boolean; disabled: boolean; onChange(value: OptimizationOptions): void; onCrossBin(value: boolean): void };
export default function OptimizationEditor({ value, crossBin, disabled, onChange, onCrossBin }: Props) {
  const numbers = [['iterations', '优化轮数', 0, 30], ['maxEvaluations', '计算量上限', 1, 2000000], ['restarts', '候选起点数', 1, 8], ['seed', '随机种子', 0, 4294967295], ['islandMaxSize', '小色块尺寸上限', 1, 16]] as const;
  return <details className="beadify-advanced"><summary>结构优化高级选项</summary>
    <p className="beadify-hint">留空使用风格默认值。增加计算量会延长生成时间；文字增强会在普通候选上追加一次优化。</p>
    <fieldset disabled={disabled}>
      {numbers.map(([key, label, min, max]) => <label key={key}>{label}<input aria-label={`Optimization ${key}`} type="number" min={min} max={max} placeholder="自动" value={value[key] ?? ''} onChange={e => {
        const next = { ...value }; if (e.target.value === '') delete next[key]; else next[key] = Math.min(max, Math.max(min, Math.round(Number(e.target.value)))); onChange(next);
      }} /></label>)}
      <label>颜色匹配方式<select aria-label="Optimization unary" value={value.unary ?? ''} onChange={e => { const next = { ...value }; if (e.target.value) next.unary = e.target.value as 'modes' | 'representative'; else delete next.unary; onChange(next); }}><option value="">自动</option><option value="modes">多个原图颜色</option><option value="representative">代表颜色</option></select></label>
      {([['sourceComponents', '保留原图小主体与细线'], ['sourceShapes', '保留路径、端点与内部形状'], ['sourceColors', '优先保留有代表性的彩色区域']] as const).map(([key, label]) => <label key={key}><span>{label}</span><input aria-label={`Optimization ${key}`} type="checkbox" checked={value[key] ?? true} onChange={e => onChange({ ...value, [key]: e.target.checked })} /></label>)}
      <label><span>连接不同色阶中的连续笔画</span><input aria-label="Cross-bin strokes" type="checkbox" checked={crossBin} onChange={e => onCrossBin(e.target.checked)} /></label>
      <details><summary>各项优化权重（0–10）</summary>
        {([['color', '颜色'], ['smooth', '平滑'], ['edge', '边缘'], ['island', '小色块'], ['palette', '色数'], ['feature', '原图细节与文字'], ['symmetry', '对称']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={`Weight ${key}`} type="number" min={0} max={10} step={0.05} placeholder="按风格" value={value.weights?.[key] ?? ''} onChange={e => {
          const weights = { ...value.weights }; if (e.target.value === '') delete weights[key]; else weights[key] = Math.min(10, Math.max(0, Number(e.target.value))); onChange({ ...value, weights });
        }} /></label>)}
      </details>
      <button onClick={() => { onChange({}); onCrossBin(true); }}>恢复默认优化选项</button>
    </fieldset>
  </details>;
}

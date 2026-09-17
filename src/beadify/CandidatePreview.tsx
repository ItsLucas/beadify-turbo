import type { ConvertResult } from '../types';
import { getColor } from '../palette';
import type { Palette } from './contracts/index';
export default function CandidatePreview({ result, palette }: { result: ConvertResult; palette?: Palette }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const context = ref.current?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, result.width, result.height);
    result.cells.forEach((cell, index) => {
      if (cell === null) return;
      const snapshot = palette?.colors.find(color => color.id === cell || `mard-${color.code.toLowerCase()}` === cell);
      context.fillStyle = snapshot ? `rgb(${snapshot.srgb8.join(',')})` : getColor(cell)?.hex ?? '#ff00ff';
      context.fillRect(index % result.width, Math.floor(index / result.width), 1, 1);
    });
  }, [result, palette]);
  return <canvas ref={ref} width={result.width} height={result.height} className="beadify-candidate-preview" aria-label="Candidate preview" />;
}

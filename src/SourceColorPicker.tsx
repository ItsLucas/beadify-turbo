import { decodeImage } from './beadify/adapter';
import type { RgbaImage } from './beadify/contracts';
import { sampleSourceColor, similarSourceColors, sourceColorHex } from './source-color-picker';
import type { PaletteColor } from './types';

type Props = {
  file: File | null;
  onFileChange: (file: File) => void;
  sourceFile: File | null;
  referenceFile: File | null;
  palette: PaletteColor[];
  language: 'zh' | 'en';
  onSelect: (colorId: string) => void;
  onClose: () => void;
};

export default function SourceColorPicker({ file, onFileChange: setFile, sourceFile, referenceFile, palette, language, onSelect, onClose }: Props) {
  const zh = language === 'zh';
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [decoded, setDecoded] = React.useState<{ file: File; image: RgbaImage } | null>(null);
  const [error, setError] = React.useState('');
  const [point, setPoint] = React.useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [viewport, setViewport] = React.useState({ width: 600, height: 400 });
  const image = decoded?.file === file ? decoded.image : null;
  const sample = React.useMemo(() => image && point ? sampleSourceColor(image, point.x, point.y) : null, [image, point]);
  const candidates = React.useMemo(() => sample ? similarSourceColors(sample.rgb, palette) : [], [sample, palette]);
  const fit = image ? Math.min(viewport.width / image.width, viewport.height / image.height) : 1;
  const hex = sample ? sourceColorHex(sample.rgb) : '';

  React.useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setDecoded(null); setError(''); setPoint(null); setZoom(1);
    if (file) decodeImage(file).then(image => {
      if (!cancelled) setDecoded({ file, image });
    }).catch(error => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [file]);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => setViewport({ width: viewport.clientWidth, height: viewport.clientHeight }));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (image && context) context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  }, [image]);

  function chooseFile(next: File) {
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(next.type)) {
      setError(zh ? '请使用 PNG、JPG 或 WebP 图片。' : 'Use a PNG, JPG, or WebP image.');
      return;
    }
    setFile(next);
  }

  return <dialog ref={dialogRef} className="source-color-dialog" aria-labelledby="source-color-title" aria-describedby="source-color-help"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => event.stopPropagation()}
    onPaste={event => {
      event.stopPropagation();
      const next = [...(event.clipboardData.files)].find(file => file.type.startsWith('image/'));
      if (next) { event.preventDefault(); chooseFile(next); }
    }}
    onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
    onDrop={event => {
      event.preventDefault(); event.stopPropagation();
      const next = [...event.dataTransfer.files].find(file => file.type.startsWith('image/'));
      if (next) chooseFile(next);
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="source-color-header">
      <h2 id="source-color-title">{zh ? '从原图取色' : 'Pick from source image'}</h2>
      <button type="button" onClick={onClose} aria-label={zh ? '关闭取色弹窗' : 'Close color picker'}>{zh ? '关闭' : 'Close'}</button>
    </header>
    <p id="source-color-help">{zh ? '点击图片查看参照色，再选择相近的拼豆色号。可放大图片取细节。' : 'Click the image to sample a reference color, then choose a similar bead color. Zoom in for details.'}</p>
    <div className="source-color-toolbar">
      {sourceFile && <button type="button" aria-pressed={file === sourceFile} onClick={() => setFile(sourceFile)}>{zh ? '生成原图' : 'Source image'}</button>}
      {referenceFile && referenceFile !== sourceFile && <button type="button" aria-pressed={file === referenceFile} onClick={() => setFile(referenceFile)}>{zh ? '参考图' : 'Reference image'}</button>}
      <button type="button" onClick={() => fileRef.current?.click()}>{zh ? '选择取色图片' : 'Choose an image'}</button>
      <input ref={fileRef} className="hidden-input" type="file" accept="image/png,image/jpeg,image/webp" aria-label={zh ? '取色图片文件' : 'Color picker image file'} onChange={event => {
        const next = event.currentTarget.files?.[0];
        if (next) chooseFile(next);
        event.currentTarget.value = '';
      }} />
      <label>{zh ? '放大' : 'Zoom'}<input type="range" aria-label={zh ? '取色图片缩放' : 'Color picker zoom'} min="1" max="8" step="0.5" value={zoom} disabled={!image} onChange={event => setZoom(Number(event.target.value))} /><span>{zoom}×</span></label>
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="source-color-layout">
      <div className="source-color-image-section">
        <div ref={viewportRef} className="source-color-viewport">
          {image ? <div className="source-color-image-scroll"><div className="source-color-image" style={{ width: image.width * fit * zoom, height: image.height * fit * zoom }}>
            <canvas ref={canvasRef} width={image.width} height={image.height} tabIndex={0} role="img"
              aria-label={zh ? '原图取色画布' : 'Source color sampling canvas'} aria-describedby="source-color-keyboard"
              onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect();
                setPoint({ x: Math.min(image.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) * image.width / rect.width))),
                  y: Math.min(image.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) * image.height / rect.height))) });
                event.currentTarget.focus({ preventScroll: true });
              }}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                const current = point ?? { x: Math.floor(image.width / 2), y: Math.floor(image.height / 2) };
                setPoint({ x: Math.max(0, Math.min(image.width - 1, current.x + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))),
                  y: Math.max(0, Math.min(image.height - 1, current.y + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))) });
              }} />
            {point && <span className="source-color-marker" aria-hidden="true" style={{ left: `${(point.x + 0.5) / image.width * 100}%`, top: `${(point.y + 0.5) / image.height * 100}%` }} />}
          </div></div> : <p className="source-color-empty">{!file ? (zh ? '选择一张图片开始取色，也可以粘贴或拖入图片。' : 'Choose, paste, or drop an image to start sampling.') : error ? (zh ? '图片未能加载，请重新选择。' : 'Could not load the image. Choose another one.') : (zh ? '正在加载原图…' : 'Loading image…')}</p>}
        </div>
        <small className="source-color-filename">{file?.name}</small>
        <small id="source-color-keyboard">{zh ? '键盘：聚焦图片后，方向键逐像素取色。' : 'Keyboard: focus the image and use arrow keys to sample pixels.'}</small>
      </div>
      <section className="source-color-results" aria-label={zh ? '取色结果' : 'Sampled colors'}>
        <div aria-live="polite">
          <h3>{zh ? '参照色' : 'Reference color'}</h3>
          {sample ? <>
            <div className="source-color-reference"><span style={{ backgroundColor: hex }} /><div><strong>{hex}</strong><small>RGB {sample.rgb.join(', ')}</small></div></div>
            {sample.alpha < 255 && <p>{zh ? '半透明像素按白底显示色匹配。' : 'Translucent pixels are matched as displayed on white.'}</p>}
          </> : <p>{point ? (zh ? '这里是透明区域，请选择有颜色的位置。' : 'This area is transparent. Choose a colored pixel.') : (zh ? '点击原图中想要的颜色。' : 'Click a color in the source image.')}</p>}
        </div>
        <h3>{zh ? '相近拼豆色' : 'Similar bead colors'}</h3>
        <p>{zh ? `从当前 ${palette.length} 色色卡中按接近程度排序，点击色号即可使用。屏幕颜色与实物可能有差异。` : `Closest matches from the current ${palette.length}-color palette. Click a code to use it. Physical beads may differ from screen colors.`}</p>
        <div className="source-color-candidates">
          {candidates.map((color, index) => <button key={color.id} type="button" aria-label={`${zh ? '使用' : 'Use'} ${color.primaryCode}`} onClick={() => onSelect(color.id)}>
            <span className="source-color-candidate-swatch" style={{ backgroundColor: color.hex }} />
            <span><strong>{color.primaryCode}</strong><small>{color.hex.toUpperCase()}</small></span>
            {index === 0 && <small className="source-color-closest">{zh ? '最接近' : 'Closest'}</small>}
          </button>)}
        </div>
      </section>
    </div>
  </dialog>;
}

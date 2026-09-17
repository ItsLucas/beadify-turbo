import { composeVisibleCells, projectColor, projectWithSnapshot } from '../project';
import { summarizeUsage } from '../usage';
import { paletteHash } from './core/index';
import type { BeadProject, UsageRow } from '../types';
import type { Bom } from './contracts/index';

export type PrintExportOptions = {
  format?: 'png' | 'pdf' | 'svg' | 'preview';
  exportBounds?: 'pattern' | 'canvas';
  showColorCodes: boolean;
  showGuideLines: boolean;
  projectName?: string;
  authorName?: string;
  layerName?: string;
  layerLabelPrefix?: string;
  paperSize?: 'a4' | 'letter';
  pitchMm?: number;
  mirror?: boolean;
  overlapCells?: number;
};
export const defaultPrintOptions: PrintExportOptions = { showColorCodes: true, showGuideLines: true };
export type ExportGrid = { width: number; height: number; cells: Array<string | null>; originX: number; originY: number; mirrored: boolean };
export type PrintPage = { kind: 'pattern' | 'legend'; x: number; y: number; columns: number; rows: number; legendStart: number; legendCount: number };
export type PrintLayout = { paperWidthMm: number; paperHeightMm: number; pitchMm: number; grid: ExportGrid; pages: PrintPage[]; usage: UsageRow[] };

/** Every physical export starts here, independent of active layer and usage checkboxes. */
export function exportGrid(project: BeadProject, options: PrintExportOptions = defaultPrintOptions): ExportGrid {
  const cells = project.layers?.length ? composeVisibleCells(project.layers, project.width, project.height) : project.cells.slice();
  let left = 0, top = 0, right = project.width - 1, bottom = project.height - 1;
  if (options.exportBounds !== 'canvas') {
    let found = false;
    cells.forEach((cell, index) => {
      if (!cell) return;
      const x = index % project.width, y = Math.floor(index / project.width);
      if (!found) { left = right = x; top = bottom = y; found = true; }
      else { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    });
  }
  const width = right - left + 1, height = bottom - top + 1;
  return { width, height, originX: left, originY: top, mirrored: !!options.mirror,
    cells: Array.from({ length: width * height }, (_, index) => {
      const x = index % width, y = Math.floor(index / width);
      return cells[(top + y) * project.width + left + (options.mirror ? width - 1 - x : x)];
    }),
  };
}

export function visibleBom(project: BeadProject): Bom {
  const saved = projectWithSnapshot(project);
  const palette = saved.beadify!.paletteSnapshot;
  const paletteByCode = new Map(palette.colors.map(color => [color.code.toLowerCase(), color]));
  const rows = summarizeUsage(saved).map(({ color, count }) => {
    const entry = paletteByCode.get(color.primaryCode.toLowerCase())!;
    return { colorId: entry.id, brand: entry.brand, series: entry.series, code: entry.code, srgb8: [...entry.srgb8] as [number, number, number], count };
  });
  return { schemaVersion: 1, paletteHash: paletteHash(palette), totalBeads: rows.reduce((sum, row) => sum + row.count, 0), rows };
}

function pitch(options: PrintExportOptions): number {
  const value = options.pitchMm ?? 5;
  if (!Number.isFinite(value) || value < 1 || value > 10) throw new Error('Pegboard pitch must be between 1 and 10 mm.');
  return value;
}

export function printLayout(project: BeadProject, options: PrintExportOptions = defaultPrintOptions): PrintLayout {
  const pitchMm = pitch(options);
  if (options.paperSize !== undefined && !['a4', 'letter'].includes(options.paperSize)) throw new Error('Unsupported paper size.');
  const [paperWidthMm, paperHeightMm] = options.paperSize === 'letter' ? [215.9, 279.4] : [210, 297];
  const columns = Math.floor((paperWidthMm - 30) / pitchMm), rows = Math.floor((paperHeightMm - 65) / pitchMm);
  const overlap = options.overlapCells ?? 1;
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > 5 || overlap >= Math.min(columns, rows)) throw new Error('Page overlap must be an integer between 0 and 5 cells.');
  const grid = exportGrid(project, options), usage = summarizeUsage(project), pages: PrintPage[] = [];
  for (let y = 0; y < grid.height;) {
    for (let x = 0; x < grid.width;) {
      pages.push({ kind: 'pattern', x, y, columns: Math.min(columns, grid.width - x), rows: Math.min(rows, grid.height - y), legendStart: 0, legendCount: 0 });
      if (x + columns >= grid.width) break;
      x += columns - overlap;
    }
    if (y + rows >= grid.height) break;
    y += rows - overlap;
  }
  const legendPerPage = 3 * Math.floor((paperHeightMm - 65) / 8);
  for (let start = 0; start < usage.length; start += legendPerPage) {
    pages.push({ kind: 'legend', x: 0, y: 0, columns: 0, rows: 0, legendStart: start, legendCount: Math.min(legendPerPage, usage.length - start) });
  }
  return { paperWidthMm, paperHeightMm, pitchMm, grid, pages, usage };
}

function xml(value: unknown): string { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!)); }
function n(value: number): string { return String(Number(value.toFixed(4))); }
function text(x: number, y: number, value: unknown, size = 3, attributes = ''): string { return `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" ${attributes}>${xml(value)}</text>`; }
function line(x1: number, y1: number, x2: number, y2: number, color = '#8b949e', weight = 0.15): string { return `<path d="M${n(x1)} ${n(y1)}H${n(x2)}V${n(y2)}" fill="none" stroke="${color}" stroke-width="${n(weight)}"/>`; }
function wrapSvg(width: number, height: number, content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}mm" height="${n(height)}mm" viewBox="0 0 ${n(width)} ${n(height)}"><rect width="100%" height="100%" fill="white"/><g font-family="Arial, sans-serif" fill="#17202a">${content}</g></svg>`;
}
function heading(project: BeadProject, options: PrintExportOptions, grid: ExportGrid, pitchMm: number, usage: UsageRow[]): string {
  return text(10, 10, options.projectName?.trim() || project.name || 'Beadify', 4)
    + text(10, 16, `${grid.width} × ${grid.height} · ${usage.length} colors · ${usage.reduce((sum, row) => sum + row.count, 0)} beads · pitch ${pitchMm} mm`, 2.7)
    + text(10, 21, `Grid ${n(grid.width * pitchMm)} × ${n(grid.height * pitchMm)} mm${options.mirror ? ' · Mirrored' : ''}${options.authorName?.trim() ? ` · ${options.authorName.trim()}` : ''}`, 2.7);
}
function gridSvg(project: BeadProject, grid: ExportGrid, page: PrintPage, options: PrintExportOptions, pitchMm: number): string {
  let svg = '';
  const left = 15, top = 28;
  for (let y = 0; y < page.rows; y++) for (let x = 0; x < page.columns; x++) {
    const gx = page.x + x, gy = page.y + y, id = grid.cells[gy * grid.width + gx];
    if (!id) continue;
    const color = projectColor(project, id);
    if (!color) throw new Error(`Unknown export color: ${id}`);
    const lx = left + x * pitchMm, ty = top + y * pitchMm;
    svg += `<rect data-bead="${xml(id)}" data-grid-x="${gx}" data-grid-y="${gy}" x="${n(lx)}" y="${n(ty)}" width="${n(pitchMm)}" height="${n(pitchMm)}" fill="${color.hex}"/>`;
    if (options.showColorCodes) {
      const bright = color.rgb[0] * 0.299 + color.rgb[1] * 0.587 + color.rgb[2] * 0.114;
      svg += text(lx + pitchMm / 2, ty + pitchMm * 0.63, color.primaryCode, pitchMm * Math.min(0.29, 0.95 / color.primaryCode.length), `text-anchor="middle" fill="${bright < 130 ? 'white' : '#111827'}"`);
    }
  }
  for (let x = 0; x <= page.columns; x++) {
    const gx = page.x + x, physicalX = grid.originX + (grid.mirrored ? grid.width - gx : gx);
    const guide = options.showGuideLines && physicalX % 5 === 0;
    svg += line(left + x * pitchMm, top, left + x * pitchMm, top + page.rows * pitchMm, guide ? '#c93645' : '#8b949e', guide ? 0.4 : 0.12);
    if (x < page.columns) svg += text(left + (x + 0.5) * pitchMm, top - 1.5, grid.originX + (grid.mirrored ? grid.width - 1 - gx : gx) + 1, Math.min(2.2, pitchMm * 0.5), 'text-anchor="middle"');
  }
  for (let y = 0; y <= page.rows; y++) {
    const physicalY = grid.originY + page.y + y;
    const guide = options.showGuideLines && physicalY % 5 === 0;
    svg += line(left, top + y * pitchMm, left + page.columns * pitchMm, top + y * pitchMm, guide ? '#c93645' : '#8b949e', guide ? 0.4 : 0.12);
    if (y < page.rows) svg += text(left - 1.5, top + (y + 0.65) * pitchMm, physicalY + 1, Math.min(2.2, pitchMm * 0.5), 'text-anchor="end"');
  }
  return svg;
}
function legendSvg(usage: UsageRow[], left: number, top: number, width: number, columns: number): string {
  return usage.map((row, index) => {
    const x = left + index % columns * width / columns, y = top + Math.floor(index / columns) * 8;
    return `<g data-legend="${xml(row.color.id)}"><rect x="${n(x)}" y="${n(y)}" width="5" height="5" fill="${row.color.hex}" stroke="#777" stroke-width="0.15"/>${text(x + 7, y + 3.6, `${row.color.primaryCode} × ${row.count}`, 2.8)}</g>`;
  }).join('');
}
function calibration(height: number, pageNumber?: string): string {
  const y = height - 17;
  return `<g data-calibration-mm="50">${line(15, y, 65, y, '#111827', 0.3)}${line(15, y - 1.5, 15, y + 1.5, '#111827', 0.3)}${line(65, y - 1.5, 65, y + 1.5, '#111827', 0.3)}${text(40, y - 2, '50 mm', 2.5, 'text-anchor="middle"')}</g>`
    + text(15, height - 10, `Print at 100% / Actual size. Disable fit-to-page.${pageNumber ? ` · ${pageNumber}` : ''}`, 2.5)
    + text(15, height - 5, 'Check ruler and pegboard pitch before use. Physical print not verified.', 2.3);
}

export function renderPatternSvg(project: BeadProject, options: PrintExportOptions = defaultPrintOptions): string {
  const grid = exportGrid(project, options), pitchMm = pitch(options), usage = summarizeUsage(project);
  const width = Math.max(150, grid.width * pitchMm + 30), columns = Math.max(1, Math.floor((width - 30) / 55));
  const legendTop = 28 + grid.height * pitchMm + 10;
  const height = legendTop + Math.ceil(usage.length / columns) * 8 + 30;
  const page: PrintPage = { kind: 'pattern', x: 0, y: 0, columns: grid.width, rows: grid.height, legendStart: 0, legendCount: usage.length };
  return wrapSvg(width, height, heading(project, options, grid, pitchMm, usage) + gridSvg(project, grid, page, options, pitchMm) + legendSvg(usage, 15, legendTop, width - 30, columns) + calibration(height));
}

export function renderPrintPageSvg(project: BeadProject, options: PrintExportOptions, layout: PrintLayout, pageIndex: number): string {
  const page = layout.pages[pageIndex];
  if (!page) throw new Error('Unknown print page.');
  const content = page.kind === 'pattern'
    ? gridSvg(project, layout.grid, page, options, layout.pitchMm)
    : text(15, 28, 'Color legend / total visible pattern', 3.5) + legendSvg(layout.usage.slice(page.legendStart, page.legendStart + page.legendCount), 15, 33, layout.paperWidthMm - 30, 3);
  return wrapSvg(layout.paperWidthMm, layout.paperHeightMm,
    heading(project, options, layout.grid, layout.pitchMm, layout.usage) + content + calibration(layout.paperHeightMm, `${pageIndex + 1}/${layout.pages.length}`));
}

export async function svgCanvas(svg: string): Promise<HTMLCanvasElement> {
  const size = svg.match(/width="([\d.]+)mm" height="([\d.]+)mm"/);
  if (!size) throw new Error('Missing SVG physical size.');
  const width = Number(size[1]), height = Number(size[2]);
  // Ten pixels per mm (254 ppi); cap total allocation for very large full-grid PNGs.
  const scale = Math.min(10, 12000 / width, 12000 / height, Math.sqrt(32_000_000 / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Cannot render the print SVG.')); image.src = url; });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

export function previewCanvas(project: BeadProject, options: PrintExportOptions = defaultPrintOptions): HTMLCanvasElement {
  const grid = exportGrid(project, options), cellSize = 16;
  const canvas = document.createElement('canvas');
  canvas.width = grid.width * cellSize; canvas.height = grid.height * cellSize;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable.');
  grid.cells.forEach((id, index) => {
    if (!id) return;
    const color = projectColor(project, id);
    if (!color) throw new Error(`Unknown export color: ${id}`);
    context.fillStyle = color.hex;
    context.fillRect(index % grid.width * cellSize, Math.floor(index / grid.width) * cellSize, cellSize, cellSize);
  });
  return canvas;
}

export type PdfImagePage = { jpeg: Uint8Array; imageWidth: number; imageHeight: number; widthMm: number; heightMm: number };
/** Existing minimal PDF image container, extended to exact paper sizes and multiple pages. */
export function createImagePdf(pages: PdfImagePage[]): Blob {
  if (!pages.length) throw new Error('PDF requires a page.');
  const encoder = new TextEncoder(), parts: BlobPart[] = [], offsets: number[] = [];
  let length = 0;
  const push = (value: string | Uint8Array) => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    parts.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); length += bytes.length;
  };
  const object = (id: number, chunks: Array<string | Uint8Array>) => { offsets[id] = length; push(`${id} 0 obj\n`); chunks.forEach(push); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  object(2, [`<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ')}] /Count ${pages.length} >>`]);
  pages.forEach((page, index) => {
    const pageId = 3 + index * 3, widthPt = n(page.widthMm / 25.4 * 72), heightPt = n(page.heightMm / 25.4 * 72);
    const content = `q\n${widthPt} 0 0 ${heightPt} 0 0 cm\n/Im0 Do\nQ`;
    object(pageId, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /XObject << /Im0 ${pageId + 1} 0 R >> >> /Contents ${pageId + 2} 0 R >>`]);
    object(pageId + 1, [`<< /Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`, page.jpeg, '\nendstream']);
    object(pageId + 2, [`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`]);
  });
  const size = 3 + pages.length * 3, xref = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: 'application/pdf' });
}

import { getColor, mappedCode } from './palette';
import { serializeProjectWithStatus } from './project';
import { summarizeUsage } from './usage';
import type { BeadProject, UsageRow } from './types';
import { createImagePdf, defaultPrintOptions, previewCanvas, printLayout, renderPatternSvg, renderPrintPageSvg, svgCanvas, visibleBom } from './beadify/export';
import type { PdfImagePage, PrintExportOptions } from './beadify/export';
export type { PrintExportOptions } from './beadify/export';

export function downloadProjectJson(project: BeadProject): { sourceRasterOmitted: boolean; textAnalysisOmitted?: boolean } {
  const result = serializeProjectWithStatus(project);
  downloadBlob(`${safeName(project.name)}-编辑记录_perler.json`, result.json, 'application/json');
  return { sourceRasterOmitted: result.sourceRasterOmitted, textAnalysisOmitted: result.textAnalysisOmitted };
}

export function usageCsv(project: BeadProject): string {
  const rows: Array<Array<string | number>> = [
    ['brand', 'series', 'code', 'hex', 'count'],
    ...visibleBom(project).rows.map(row => [row.brand, row.series, row.code, `#${row.srgb8.map(value => value.toString(16).padStart(2, '0')).join('')}`, row.count]),
  ];
  return `\ufeff${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function downloadUsageCsv(project: BeadProject, _legacyUsage?: UsageRow[]): void {
  downloadBlob(`${safeName(project.name)}-BOM.csv`, usageCsv(project), 'text/csv;charset=utf-8');
}

export function downloadUsageJson(project: BeadProject): void {
  downloadBlob(`${safeName(project.name)}-BOM.json`, JSON.stringify(visibleBom(project), null, 2), 'application/json');
}

export function downloadUsageWorkbook(project: BeadProject): void {
  const workbook = createXlsxWorkbook([{ name: '可见图纸', rows: usageSheetRows(project, '可见图纸', summarizeUsage(project)) }]);
  downloadBlob(`${safeName(project.name)}-用量清单.xlsx`, workbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

export function downloadPrintSvg(project: BeadProject, options: PrintExportOptions = defaultPrintOptions): void {
  downloadBlob(`${safeName(options.projectName || project.name)}.svg`, renderPatternSvg(project, options), 'image/svg+xml');
}

export async function downloadPrintPng(project: BeadProject, options: PrintExportOptions = defaultPrintOptions): Promise<void> {
  const canvas = await svgCanvas(renderPatternSvg(project, options));
  downloadBlob(`${safeName(options.projectName || project.name)}.png`, await pngBlob(canvas), 'image/png');
}

export async function downloadPreviewPng(project: BeadProject, options: PrintExportOptions = defaultPrintOptions): Promise<void> {
  downloadBlob(`${safeName(options.projectName || project.name)}-preview.png`, await pngBlob(previewCanvas(project, options)), 'image/png');
}

export async function downloadPrintPdf(project: BeadProject, options: PrintExportOptions = defaultPrintOptions): Promise<void> {
  const layout = printLayout(project, options), pages: PdfImagePage[] = [];
  for (let index = 0; index < layout.pages.length; index++) {
    const canvas = await svgCanvas(renderPrintPageSvg(project, options, layout, index));
    pages.push({ jpeg: dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.96)), imageWidth: canvas.width, imageHeight: canvas.height, widthMm: layout.paperWidthMm, heightMm: layout.paperHeightMm });
    canvas.width = canvas.height = 1;
  }
  downloadBlob(`${safeName(options.projectName || project.name)}.pdf`, createImagePdf(pages), 'application/pdf');
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed.')), 'image/png'));
}

type UsageWorkbookRow = Array<string | number>;

function usageSheetRows(
  project: BeadProject,
  sheetTitle: string,
  usage: Array<{ color: NonNullable<ReturnType<typeof getColor>>; count: number; packs: number }>,
): UsageWorkbookRow[] {
  const totalBeads = usage.reduce((sum, row) => sum + row.count, 0);
  return [
    ['\u9879\u76ee\u540d\u79f0', project.name || '\u62fc\u8c46\u56fe\u7eb8'],
    ['\u8868\u683c', sheetTitle],
    ['\u8272\u53f7\u54c1\u724c', project.activeBrand],
    ['\u753b\u5e03\u5c3a\u5bf8', `${project.width} x ${project.height}`],
    ['\u603b\u9897\u6570', totalBeads],
    ['\u989c\u8272\u6570', usage.length],
    ['\u6bcf\u5305\u6570\u91cf', `${project.settings.beadsPerPack} \u9897/\u5305`],
    [],
    ['\u8272\u53f7\u54c1\u724c', '\u8272\u53f7', '\u989c\u8272\u540d\u79f0', 'HEX', '\u6570\u91cf', '\u9884\u8ba1\u5305\u6570'],
    ...usage.map((row) => [
      project.activeBrand,
      mappedCode(row.color, project.activeBrand),
      row.color.name,
      row.color.hex,
      row.count,
      row.packs,
    ]),
  ];
}

function createXlsxWorkbook(sheets: Array<{ name: string; rows: UsageWorkbookRow[] }>): Blob {
  const safeSheets = uniqueSheetNames(sheets.map((sheet) => sheet.name));
  const files: Array<{ path: string; content: string }> = [
    { path: '[Content_Types].xml', content: xlsxContentTypes(sheets.length) },
    { path: '_rels/.rels', content: xlsxRootRels() },
    { path: 'xl/workbook.xml', content: xlsxWorkbookXml(safeSheets) },
    { path: 'xl/_rels/workbook.xml.rels', content: xlsxWorkbookRels(sheets.length) },
    { path: 'xl/styles.xml', content: xlsxStyles() },
    ...sheets.map((sheet, index) => ({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      content: xlsxWorksheet(sheet.rows),
    })),
  ];
  return new Blob([zipStore(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function xlsxContentTypes(sheetCount: number): string {
  const sheetOverrides = Array.from({ length: sheetCount }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`;
}

function xlsxRootRels(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
}

function xlsxWorkbookXml(sheetNames: string[]): string {
  const sheets = sheetNames.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
}

function xlsxWorkbookRels(sheetCount: number): string {
  const sheetRels = Array.from({ length: sheetCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function xlsxStyles(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>';
}

function xlsxWorksheet(rows: UsageWorkbookRow[]): string {
  const sheetRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) => xlsxCell(value, columnName(columnIndex), rowNumber, rowIndex === 8)).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="16" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/><col min="3" max="3" width="20" customWidth="1"/><col min="4" max="4" width="12" customWidth="1"/><col min="5" max="6" width="12" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`;
}

function xlsxCell(value: string | number, column: string, row: number, header: boolean): string {
  const style = header ? ' s="1"' : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${column}${row}"${style}><v>${value}</v></c>`;
  }
  return `<c r="${column}${row}" t="inlineStr"${style}><is><t>${escapeXml(String(value))}</t></is></c>`;
}

function uniqueSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name, index) => {
    const base = sanitizeSheetName(name || `Sheet ${index + 1}`);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      const tail = ` ${suffix}`;
      candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Sheet').slice(0, 31);
}

function columnName(index: number): string {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function zipStore(files: Array<{ path: string; content: string }>): ArrayBuffer {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  files.forEach((file) => {
    const nameBytes = encoder.encode(file.path);
    const contentBytes = encoder.encode(file.content);
    const crc = crc32(contentBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, contentBytes.length, true);
    local.setUint32(22, contentBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);
    parts.push(localHeader, contentBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const central = new DataView(centralHeader.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, contentBytes.length, true);
    central.setUint32(24, contentBytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length + contentBytes.length;
  });
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return concatBytes([...parts, ...centralParts, end]);
}

function concatBytes(chunks: Uint8Array[]): ArrayBuffer {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output.buffer;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function csvCell(value: string | number | undefined): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'perler-pattern';
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function downloadBlob(fileName: string, content: BlobPart, type: string): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

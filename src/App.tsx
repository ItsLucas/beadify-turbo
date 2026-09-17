import type { CoreProgress } from './beadify/core/progress';
import TextRetypeEditor from './beadify/TextRetypeEditor';
import { retypeTextPattern, type TextRetype } from './beadify/text-retype';
import TextAnalysisEditor from './beadify/TextAnalysisEditor';
import OptimizationEditor from './beadify/OptimizationEditor';
import { matchingText } from './beadify/text-web';
import type { TextAnalysis, OptimizationOptions } from './beadify/contracts';
import type { TextCandidateResult } from './beadify/worker-client';
import SubjectEditor from './beadify/SubjectEditor';
import SourceFeatureEditor from './beadify/SourceFeatureEditor';
import ConstraintEditor from './beadify/ConstraintEditor';
import { prepareImage } from './beadify/core/preprocess';
import { inspectCells, inspectConnectivity } from './beadify/core/grid';
import { sha256 } from './beadify/core/hash';
import { loadPalette, smoothImage } from './beadify/core/index';
import { currentRaster, originalInputFile, parseColorCodes, remapConstraints, resizeSourceRaster, roiConstraints, sourceRoiRequest } from './beadify/workspace-generation';
import type { CellConstraint, GenerationRequest, PreprocessingOptions, RgbaImage, SourceFeatureRegion, SourceRaster } from './beadify/contracts/index';
import type { SavedGenerationSettings } from './types';
import CandidatePreview from './beadify/CandidatePreview';
import { GenerationSession } from './beadify/generation-session';
import type { GenerationTicket } from './beadify/generation-session';
import { GenerationWorkerClient } from './beadify/worker-client';
import { decodeImage, workspacePalette, workspaceResult } from './beadify/adapter';
import type { BeadPattern } from './beadify/contracts/index';
import type { ConvertResult } from './types';
import WorkspaceCanvas from './WorkspaceCanvas';
import ThreePreview from './ThreePreview';
import { downloadPrintPdf, downloadPrintPng, downloadPrintSvg, downloadPreviewPng, downloadProjectJson, downloadUsageWorkbook, downloadUsageCsv, downloadUsageJson } from './exporters';
import type { PrintExportOptions } from './exporters';
import { imageFileToBeads } from './imageToBeads';
import { basicPalette, colorDistance, completePalette, getColor, nearestPaletteColor } from './palette';
import { composeVisibleCells, createLayer, createProject, loadDraft, normalizeProject, projectColor, saveDraftWithStatus, withCells, withLayers } from './project';
import { findIsolatedBeads, summarizeUsage } from './usage';
import type { ArrowKind, BackgroundMode, BeadProject, ClipboardPattern, CopyMode, GenerationStyle, MirrorDirection, MoveMode, RemoveMode, RightClickAction, ShapeFillMode, ShapeKind, TextDirection, ToolId } from './types';

const { useEffect, useMemo, useRef, useState } = React;

type Language = 'zh' | 'en';

const languageKey = 'perler-beads-generator:language';

const ui: Record<Language, any> = {
    zh: {
        appName: 'Beadify Turbo 拼豆工作台',
        board: '拼豆板',
        apply: '应用',
        commonSizes: '常用尺寸',
        rightClick: '右键',
        rightClickHint: '右键平移用于拖动画布；右键擦除只清除落点格子，不受橡皮大小影响。',
        pan: '平移',
        erase: '擦除',
        new: '新建',
        clear: '清空',
        undo: '撤销',
        redo: '重做',
        exportPatternFull: '导出图纸',
        exportUsageFull: '导出用量',
        exportRecordFull: '导出编辑',
        importRecordFull: '导入编辑',
        exportPatternTitle: '导出图纸',
        exportUsageTitle: '导出用量清单 Excel',
        exportRecordTitle: '导出编辑记录 JSON',
        importRecordTitle: '导入历史记录 JSON',
        usageExported: '当前可见图纸用量已导出。',
        recordExported: '编辑记录 JSON 已导出。',
        recordImported: '编辑记录已导入，可继续编辑。',
        invalidRecord: '这个文件不是有效的拼豆编辑记录。',
        unreadableRecord: '无法读取这个编辑记录 JSON。',
        printExportSettings: '图纸设置',
        showColorCodes: '显示色号',
        showGuideLines: '辅助线',
        projectNickname: '作品昵称',
        authorNickname: '作者昵称',
        exportFormat: '导出格式',
        exportBounds: '导出范围',
        exportPatternBounds: '图案尺寸',
        exportCanvasBounds: '画布尺寸',
        optional: '可选',
        exportNow: '导出',
        preview3d: '3D 预览',
        liveBoard: '实时画板视图',
        previewEmpty: '暂无 3D 预览',
        imageToPattern: '导入图片生成',
        referenceImage: '参考图',
        uploadReferenceImage: '上传参考图',
        showReferenceImage: '显示参考图',
        referenceOpacity: '透明度',
        referenceAdjust: '拖动/缩放',
        referenceAdjustHint: '正在拖动/缩放参考图',
        resetReferenceTransform: '重置位置',
        referencePlacement: '显示位置',
        referenceBelow: '拼豆下方',
        referenceAbove: '拼豆上方',
        referenceHint: '作为临摹底稿',
        ready: '已选择',
        noImage: '未选择图片',
        uploadImage: '上传图片',
        width: '宽度',
        colors: '色数上限',
        colorsHint: '生成时使用的拼豆颜色数量上限；数值越低越简洁，越高越细腻。',
        generationStyle: '生成风格',
        generationStyleCartoon: '卡通',
        generationStyleRealistic: '写实',
        tolerance: '容差',
        toleranceHint: '容差越大，越多接近背景色的像素会被去除；容差越小，边缘保留越多。',
        background: '背景',
        keepBackground: '保留背景',
        removeWhite: '去除背景',
        preparingPattern: '正在生成图案',
        autoGenerateHint: '调整参数后生成预览，接受后添加为可撤销的新图层。',
        palette: '调色盘',
        adjustments: '调整',
        adjustmentTitle: '当前图层调整',
        brightness: '亮度',
        contrast: '对比度',
        saturation: '饱和度',
        temperature: '色温',
        hue: '色相',
        resetAdjustments: '重置调整',
        adjustmentHint: '滑动会直接调整当前图层，可用撤销恢复。',
        adjustmentLocked: '当前图层已锁定，无法应用调整。',
        colorCleanup: '颜色整理',
        colorCleanupHint: '合并相近色，减少碎色。',
        applyColorCleanup: '整理相近颜色',
        colorLimit: '色数上限',
        colorLimitHint: '限制当前图层颜色数。',
        applyColorLimit: '应用色数上限',
        layerColorsCleaned: (count: number) => (count > 0 ? `已整理 ${count} 颗拼豆。` : '当前图层没有需要整理的相近颜色。'),
        layerColorsLimited: (count: number, limit: number) => (count > 0 ? `已将当前图层限制到最多 ${limit} 色。` : `当前图层已经不超过 ${limit} 色。`),
        effects: '效果',
        invertEffect: '反色',
        grayscaleEffect: '灰阶',
        blackWhiteEffect: '黑白',
        effectApplied: (name: string, count: number) => `已应用${name}，影响 ${count} 颗拼豆。`,
        mardBasic: 'MARD 基础版（221色）',
        mardComplete: 'MARD 完整版（291色）',
        recentColors: '最近使用',
        layers: '图层',
        addLayer: '新建图层',
        deleteLayer: '删除',
        duplicateLayer: '复制图层',
        renameLayer: '重命名图层',
        reorderLayer: '拖动调整图层顺序',
        activeLayer: '当前图层',
        hiddenLayer: '已隐藏',
        lockedLayer: '已锁定',
        layerBeadCount: (count: number) => `${count} 颗`,
        usage: '用量',
        totalBeadsLabel: '总颗数',
        colorTypes: '颜色数',
        estimatedPacks: '预计包数',
        beadsPerPack: '每包数量',
        perPackUnit: '颗/包',
        countedLayerTitle: '计入图层',
        countAllLayers: '全部图层',
        countCurrentLayer: '当前图层',
        packUnit: '包',
        noUsage: '暂无用量',
        brandCodes: '色号品牌',
        view: '视图',
        beadShape: '豆子形状',
        roundBeads: '圆形',
        squareBeads: '方形',
        layerOverlap: '重叠格子',
        showActiveLayerOnly: '只看当前图层',
        grid: '网格',
        coordinates: '坐标',
        countLayer: '计入用量',
        eye: '显示',
        lock: '锁定',
        unlock: '解锁',
        lockHint: '锁定后无法在这一层绘制或擦除',
        unlockHint: '解锁后可以继续编辑这一层',
        lockedCanvasHint: '当前图层已锁定',
        manyColors: '颜色较多，可以降低颜色数量。',
        countedLayers: (count: number) => `已计入 ${count} 个图层`,
        noCountedLayers: '没有图层计入用量。',
        cell: '格子',
        hoverBoard: '移动到画布上',
        empty: '空',
        language: '语言',
        fit: '适配',
        close: '关闭',
        expandPreview: '放大 3D 预览',
        workspaceReady: '工作区已就绪。',
        heightFromRatio: '高度将按图片比例计算。',
        status: (width: number, height: number, beads: number, colors: number) => `${width} * ${height} - ${beads} 颗 - ${colors} 色`,
        panelStatus: (width: number, height: number, colors: number, beads: number, boards: number) => `${width} * ${height} - ${colors} 色 - ${beads} 颗 - ${boards} 块板`,
        isolatedBeads: (count: number) => (count > 0 ? `${count} 颗拼豆无相邻，熨烫时留意。` : '没有无相邻拼豆。'),
        showIsolatedBeads: '显示无相邻拼豆',
        hideIsolatedBeads: '隐藏无相邻拼豆',
        eraserSize: '橡皮大小',
        removeScope: '消除范围',
        removeSameConnected: '同色连续',
        removeAllSameColor: '所有同色',
        removeConnected: '连续块',
        moveScope: '选中范围',
        moveLayer: '全图层',
        movePartial: '局部',
        panToolHint: '提示：使用其他工具时，右键默认用于拖动画布',
        mirrorDirection: '镜像方向',
        mirrorHorizontal: '左右',
        mirrorVertical: '上下',
        shapeType: '形状',
        shapeStyle: '样式',
        shapeOutline: '空心',
        shapeFilled: '实心',
        shapeLine: '直线',
        shapeRectangle: '矩形',
        shapeSquare: '正方',
        shapeEllipse: '椭圆',
        shapeCircle: '正圆',
        shapeTriangle: '三角',
        shapeArrow: '箭头',
        arrowStyle: '箭头',
        arrowSingle: '单向',
        arrowDouble: '双向',
        arrowBlock: '粗箭头',
        textContent: '文字内容',
        textDirection: '排列方向',
        textHorizontal: '横排',
        textVertical: '竖排',
        textSize: '文字高度',
        textSpacing: '文字间距',
        textPlaceholder: '文字 / 数字 / 字母 / 符号',
        clipboardPreview: '剪贴预览',
        clipboardEmpty: <>先用复制工具选择<br />复制范围</>,
        clipboardSize: (width: number, height: number, beads: number) => `${width} * ${height} - ${beads} 颗`,
        resetClipboard: '重置剪贴预览',
        copyScope: '复制范围',
        copyConnected: '连续块',
        copySelection: '多选拼豆',
        copySelectionHint: '左键选择或取消要复制的拼豆',
        copiedPattern: (width: number, height: number, beads: number) => `已复制 ${width} * ${height} 图案，${beads} 颗。`,
        copySelectionUpdated: (beads: number) => `已选择 ${beads} 颗拼豆。`,
        clipboardReset: '剪贴预览已重置。',
        pastedPattern: '已粘贴图案。',
        recoloredBeads: (count: number) => `已替换 ${count} 颗同色拼豆。`,
        brushCells: (count: number) => `${formatBrushSize(count)} 格`,
        tools: {
            pencil: { title: '画笔', hint: '绘制拼豆' },
            eraser: { title: '橡皮', hint: '清除格子' },
            fill: { title: '填充', hint: '填充区域' },
            remove: { title: '消除', hint: '清除连续区域' },
            recolor: { title: '换色', hint: '替换同色拼豆' },
            eyedropper: { title: '吸管', hint: '拾取颜色' },
            move: { title: '移动', hint: '移动当前图层图案' },
            copy: { title: '复制', hint: '复制连续图案' },
            paste: { title: '粘贴', hint: '粘贴已复制图案' },
            mirror: { title: '镜像', hint: '翻转当前图层图案' },
            shape: { title: '形状', hint: '绘制基础几何图形' },
            text: { title: '文字', hint: '插入点阵文字' },
            pan: { title: '拖动', hint: '拖动画布' },
        },
    },
    en: {
        appName: 'Beadify Turbo',
        board: 'Pegboard',
        apply: 'Apply',
        commonSizes: 'Common sizes',
        rightClick: 'Right click',
        rightClickHint: 'Right-click pan drags the canvas; right-click erase clears only the pointed cell and ignores eraser size.',
        pan: 'Pan',
        erase: 'Erase',
        new: 'New',
        clear: 'Clear',
        undo: 'Undo',
        redo: 'Redo',
        exportPatternFull: 'Export pattern',
        exportUsageFull: 'Export usage',
        exportRecordFull: 'Export edit',
        importRecordFull: 'Import edit',
        exportPatternTitle: 'Export pattern',
        exportUsageTitle: 'Export usage workbook',
        exportRecordTitle: 'Export edit record JSON',
        importRecordTitle: 'Import edit history JSON',
        usageExported: 'Usage workbook exported.',
        recordExported: 'Edit record JSON exported.',
        recordImported: 'Edit record imported. You can keep editing.',
        invalidRecord: 'This file is not a valid edit record.',
        unreadableRecord: 'Could not read this edit record JSON.',
        printExportSettings: 'Pattern settings',
        showColorCodes: 'Color codes',
        showGuideLines: 'Guide lines',
        projectNickname: 'Pattern name',
        authorNickname: 'Author name',
        exportFormat: 'Export format',
        exportBounds: 'Export bounds',
        exportPatternBounds: 'Pattern size',
        exportCanvasBounds: 'Canvas size',
        optional: 'Optional',
        exportNow: 'Export',
        preview3d: '3D Preview',
        liveBoard: 'Live board view',
        previewEmpty: 'No 3D preview yet',
        imageToPattern: 'Import Image',
        referenceImage: 'Reference Image',
        uploadReferenceImage: 'Upload reference',
        showReferenceImage: 'Show reference',
        referenceOpacity: 'Opacity',
        referenceAdjust: 'Move/scale',
        referenceAdjustHint: 'Moving/scaling reference image',
        resetReferenceTransform: 'Reset position',
        referencePlacement: 'Display position',
        referenceBelow: 'Below beads',
        referenceAbove: 'Above beads',
        referenceHint: 'Tracing guide',
        ready: 'Ready',
        noImage: 'No image',
        uploadImage: 'Upload image',
        width: 'Width',
        colors: 'Color limit',
        colorsHint: 'Maximum bead colors used in generation; lower is simpler, higher keeps more detail.',
        generationStyle: 'Style',
        generationStyleCartoon: 'Cartoon',
        generationStyleRealistic: 'Realistic',
        tolerance: 'Tolerance',
        toleranceHint: 'Higher tolerance removes more pixels close to the background color; lower tolerance keeps more edge detail.',
        background: 'Background',
        keepBackground: 'Keep background',
        removeWhite: 'Remove background',
        preparingPattern: 'Generating pattern',
        autoGenerateHint: 'Preview a result, then accept it as a new layer.',
        palette: 'Palette',
        adjustments: 'Adjust',
        adjustmentTitle: 'Active layer adjustment',
        brightness: 'Brightness',
        contrast: 'Contrast',
        saturation: 'Saturation',
        temperature: 'Temperature',
        hue: 'Hue',
        resetAdjustments: 'Reset adjustments',
        adjustmentHint: 'Sliders adjust the active layer directly; Undo can restore it.',
        adjustmentLocked: 'The active layer is locked.',
        colorCleanup: 'Color cleanup',
        colorCleanupHint: 'Merge close colors and reduce speckles.',
        applyColorCleanup: 'Merge close colors',
        colorLimit: 'Color limit',
        colorLimitHint: 'Limit colors in the active layer.',
        applyColorLimit: 'Apply color limit',
        layerColorsCleaned: (count: number) => (count > 0 ? `${count} beads cleaned up.` : 'No close colors need cleanup in the active layer.'),
        layerColorsLimited: (count: number, limit: number) => (count > 0 ? `Active layer limited to ${limit} colors.` : `Active layer already has ${limit} colors or fewer.`),
        effects: 'Effects',
        invertEffect: 'Invert',
        grayscaleEffect: 'Grayscale',
        blackWhiteEffect: 'B/W',
        effectApplied: (name: string, count: number) => `${name} applied to ${count} beads.`,
        mardBasic: 'MARD Basic (221 colors)',
        mardComplete: 'MARD Complete (291 colors)',
        recentColors: 'Recent',
        layers: 'Layers',
        addLayer: 'New layer',
        deleteLayer: 'Delete',
        duplicateLayer: 'Duplicate layer',
        renameLayer: 'Rename layer',
        reorderLayer: 'Drag to reorder layer',
        activeLayer: 'Active layer',
        hiddenLayer: 'Hidden',
        lockedLayer: 'Locked',
        layerBeadCount: (count: number) => `${count} beads`,
        usage: 'Usage',
        totalBeadsLabel: 'Total beads',
        colorTypes: 'Colors',
        estimatedPacks: 'Est. packs',
        beadsPerPack: 'Beads per pack',
        perPackUnit: 'beads/pack',
        countedLayerTitle: 'Counted layers',
        countAllLayers: 'All layers',
        countCurrentLayer: 'Current layer',
        packUnit: 'packs',
        noUsage: 'No usage yet',
        brandCodes: 'Brand codes',
        view: 'View',
        beadShape: 'Bead shape',
        roundBeads: 'Round',
        squareBeads: 'Square',
        layerOverlap: 'Overlap cells',
        showActiveLayerOnly: 'Current layer only',
        grid: 'Grid',
        coordinates: 'Coordinates',
        countLayer: 'Count this layer in usage',
        eye: 'Eye',
        lock: 'Lock',
        unlock: 'Unlock',
        lockHint: 'Lock this layer to prevent drawing or erasing on it',
        unlockHint: 'Unlock this layer to edit it again',
        lockedCanvasHint: 'Current layer is locked',
        manyColors: 'Many colors; consider lowering max colors.',
        countedLayers: (count: number) => `${count} layers counted`,
        noCountedLayers: 'No layers counted in usage.',
        cell: 'Cell',
        hoverBoard: 'Hover the board',
        empty: 'empty',
        language: 'Language',
        fit: 'Fit',
        close: 'Close',
        expandPreview: 'Expand 3D preview',
        workspaceReady: 'Workspace ready.',
        heightFromRatio: 'Height is calculated from the image ratio.',
        status: (width: number, height: number, beads: number, colors: number) => `${width} * ${height} - ${beads} beads - ${colors} colors`,
        panelStatus: (width: number, height: number, colors: number, beads: number, boards: number) => `${width} * ${height} - ${colors} colors - ${beads} beads - ${boards} boards`,
        isolatedBeads: (count: number) => (count > 0 ? `${count} beads have no neighbors; watch when fusing.` : 'No beads without neighbors.'),
        showIsolatedBeads: 'Show beads without neighbors',
        hideIsolatedBeads: 'Hide beads without neighbors',
        eraserSize: 'Eraser size',
        removeScope: 'Clear range',
        removeSameConnected: 'Same area',
        removeAllSameColor: 'All same',
        removeConnected: 'Connected',
        moveScope: 'Selection',
        moveLayer: 'Layer',
        movePartial: 'Partial',
        panToolHint: 'Tip: when using other tools, right-click drags the canvas by default.',
        mirrorDirection: 'Mirror',
        mirrorHorizontal: 'Left-right',
        mirrorVertical: 'Up-down',
        shapeType: 'Shape',
        shapeStyle: 'Style',
        shapeOutline: 'Outline',
        shapeFilled: 'Filled',
        shapeLine: 'Line',
        shapeRectangle: 'Rect',
        shapeSquare: 'Square',
        shapeEllipse: 'Oval',
        shapeCircle: 'Circle',
        shapeTriangle: 'Triangle',
        shapeArrow: 'Arrow',
        arrowStyle: 'Arrow',
        arrowSingle: 'Single',
        arrowDouble: 'Double',
        arrowBlock: 'Block',
        textContent: 'Text',
        textDirection: 'Direction',
        textHorizontal: 'Horizontal',
        textVertical: 'Vertical',
        textSize: 'Text height',
        textSpacing: 'Spacing',
        textPlaceholder: 'Text / numbers / letters / symbols',
        clipboardPreview: 'Clipboard',
        clipboardEmpty: 'Copy a pattern first',
        clipboardSize: (width: number, height: number, beads: number) => `${width} * ${height} - ${beads} beads`,
        resetClipboard: 'Reset clipboard preview',
        copyScope: 'Copy range',
        copyConnected: 'Connected',
        copySelection: 'Select beads',
        copySelectionHint: 'Left-click to select or deselect individual beads.',
        copiedPattern: (width: number, height: number, beads: number) => `Copied ${width} x ${height}, ${beads} beads.`,
        copySelectionUpdated: (beads: number) => `${beads} beads selected.`,
        clipboardReset: 'Clipboard preview reset.',
        pastedPattern: 'Pattern pasted.',
        recoloredBeads: (count: number) => `${count} matching beads recolored.`,
        brushCells: (count: number) => `${formatBrushSize(count)} cells`,
        tools: {
            pencil: { title: 'Pencil', hint: 'Paint beads' },
            eraser: { title: 'Eraser', hint: 'Clear cells' },
            fill: { title: 'Fill', hint: 'Fill an area' },
            remove: { title: 'Clear', hint: 'Clear connected area' },
            recolor: { title: 'Recolor', hint: 'Replace matching beads' },
            eyedropper: { title: 'Dropper', hint: 'Pick color' },
            move: { title: 'Move', hint: 'Move active layer artwork' },
            copy: { title: 'Copy', hint: 'Copy connected pattern' },
            paste: { title: 'Paste', hint: 'Paste copied pattern' },
            mirror: { title: 'Mirror', hint: 'Flip active layer artwork' },
            shape: { title: 'Shape', hint: 'Draw basic geometry' },
            text: { title: 'Text', hint: 'Insert dot text' },
            pan: { title: 'Drag', hint: 'Drag canvas' },
        },
    },
};

const tools: Array<{ id: ToolId }> = [
  { id: 'pencil' },
  { id: 'eraser' },
  { id: 'fill' },
  { id: 'remove' },
  { id: 'recolor' },
  { id: 'eyedropper' },
  { id: 'move' },
  { id: 'copy' },
  { id: 'paste' },
  { id: 'mirror' },
  { id: 'shape' },
  { id: 'text' },
  { id: 'pan' },
];

function formatBrushSize(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const sizePresets = [
  { label: '52 * 52', width: 52, height: 52 },
  { label: '78 * 78', width: 78, height: 78 },
  { label: '104 * 104', width: 104, height: 104 },
  { label: '156 * 156', width: 156, height: 156 },
];

const defaultImportSettings = {
  width: 40,
  maxColors: 12,
  generationStyle: 'cartoon' as GenerationStyle,
  backgroundMode: 'keep' as BackgroundMode,
  tolerance: 32,
  speckleReduction: 0,
};

const defaultColorId = 'mard-h7';
const defaultRecentColorIds = ['mard-h7', 'mard-h2'];
const defaultAdjustments: AdjustmentSettings = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  hue: 0,
};

type HoverCell = { x: number; y: number; colorId: string | null };
type DragTarget = { id: string; edge: 'before' | 'after' };
type PaletteMode = 'basic' | 'complete';
type FloatingHelp = { text: string; left: number; top: number };
type ReferencePlacement = 'below' | 'above';
const SAMPLING_PHASES: { label: string; value: [number, number] }[] = [
  { label: '居中', value: [0, 0] }, { label: '向左', value: [-0.35, 0] }, { label: '向右', value: [0.35, 0] },
  { label: '向上', value: [0, -0.35] }, { label: '向下', value: [0, 0.35] },
];
type GenerationCandidate = { ticket: GenerationTicket; result: ConvertResult; pattern?: BeadPattern; mode: 'generate' | 'roi'; settings: SavedGenerationSettings; sourceRaster?: SourceRaster; textResult?: TextCandidateResult; label?: string; textRetype?: TextRetype; retypeInfo?: { changedCells: number; fontSize: number } };
type LayerEffect = 'invert' | 'grayscale' | 'blackWhite';
type AdjustmentSettings = {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  hue: number;
};

function savedPaletteMode(settings?: SavedGenerationSettings): PaletteMode {
  return (settings?.allowedColors ?? []).some(id => !basicPalette.some(color => id.endsWith(`:${color.primaryCode}`))) ? 'complete' : 'basic';
}

function savedAllowedInput(settings?: SavedGenerationSettings): string {
  const allowed = settings?.allowedColors ?? [];
  const palette = savedPaletteMode(settings) === 'complete' ? completePalette : basicPalette;
  const codes = new Set(allowed.map(id => id.slice(id.lastIndexOf(':') + 1)));
  // Blank means every color in the selected palette; a large subset still needs
  // its explicit exclusions when the project is reopened.
  return allowed.length === palette.length && palette.every(color => codes.has(color.primaryCode)) ? '' : allowed.join(', ');
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const referenceInputRef = useRef<HTMLInputElement | null>(null);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);
  const [project, setProject] = useState<BeadProject>(() => loadDraft() ?? createProject());
  const generationSession = useRef(new GenerationSession());
  const generationTimer = useRef<number | null>(null);
  const generationWorker = useRef(new GenerationWorkerClient());
  const [generationMethod, setGenerationMethod] = useState<GenerationRequest['method'] | 'original'>(project.beadify?.generationSettings?.method ?? 'original');
  const [candidate, setCandidate] = useState<GenerationCandidate | null>(null);
  const [phaseCandidates, setPhaseCandidates] = useState<GenerationCandidate[]>([]);
  const [textCandidates, setTextCandidates] = useState<GenerationCandidate[]>([]);
  const [optimizationOptions, setOptimizationOptions] = useState<OptimizationOptions>(project.beadify?.generationSettings?.optimization ?? {});
  const [crossBinStrokes, setCrossBinStrokes] = useState(project.beadify?.generationSettings?.sampling?.crossBinStrokes ?? true);
  const skipAutoGeneration = useRef(false);
  const adjustmentSessionRef = useRef<{ layerId: string | null; baseCells: Array<string | null> }>({ layerId: null, baseCells: [] });
  const soloVisibilitySnapshotRef = useRef<Record<string, boolean> | null>(null);
  const [language, setLanguage] = useState<Language>(() => { try { return localStorage.getItem(languageKey) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; } });
  const text = ui[language];
  const [selectedColorId, setSelectedColorId] = useState(defaultColorId);
  const [recentColorIds, setRecentColorIds] = useState(defaultRecentColorIds);
  const [tool, setTool] = useState<ToolId>('pencil');
  const [eraserSize, setEraserSize] = useState(0);
  const [removeMode, setRemoveMode] = useState<RemoveMode>('same-connected');
  const [moveMode, setMoveMode] = useState<MoveMode>('layer');
  const [mirrorMode, setMirrorMode] = useState<MoveMode>('layer');
  const [mirrorDirection, setMirrorDirection] = useState<MirrorDirection>('horizontal');
  const [shapeKind, setShapeKind] = useState<ShapeKind>('line');
  const [shapeFillMode, setShapeFillMode] = useState<ShapeFillMode>('outline');
  const [arrowKind, setArrowKind] = useState<ArrowKind>('single');
  const [textToolValue, setTextToolValue] = useState('ABC');
  const [textToolDirection, setTextToolDirection] = useState<TextDirection>('horizontal');
  const [textToolSize, setTextToolSize] = useState(17);
  const [textToolSpacing, setTextToolSpacing] = useState(1);
  const [showPrintExportPanel, setShowPrintExportPanel] = useState(false);
  const [printExportOptions, setPrintExportOptions] = useState<PrintExportOptions>({
    format: 'png',
    exportBounds: 'pattern',
    showColorCodes: true,
    showGuideLines: true,
    projectName: '',
    authorName: '',
  });
  const [showPencilOptions, setShowPencilOptions] = useState(false);
  const [showEraserOptions, setShowEraserOptions] = useState(false);
  const [showRemoveOptions, setShowRemoveOptions] = useState(false);
  const [showMoveOptions, setShowMoveOptions] = useState(false);
  const [showMirrorOptions, setShowMirrorOptions] = useState(false);
  const [showShapeOptions, setShowShapeOptions] = useState(false);
  const [showTextOptions, setShowTextOptions] = useState(false);
  const [showClipboardOptions, setShowClipboardOptions] = useState(false);
  const [showPanOptions, setShowPanOptions] = useState(false);
  const [clipboardPattern, setClipboardPattern] = useState<ClipboardPattern | null>(null);
  const [copyMode, setCopyMode] = useState<CopyMode>('connected');
  const [copySelectionIndices, setCopySelectionIndices] = useState<number[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sourceImage, setSourceImage] = useState<RgbaImage | null>(null);
  const [sourceFileHash, setSourceFileHash] = useState<string | null>(null);
  const [preprocessing, setPreprocessing] = useState<PreprocessingOptions>(project.beadify?.generationSettings?.preprocessing ?? {});
  const [coreStyle, setCoreStyle] = useState<NonNullable<GenerationRequest['style']>>(project.beadify?.generationSettings?.style ?? 'clean');
  const [allowedInput, setAllowedInput] = useState(savedAllowedInput(project.beadify?.generationSettings));
  const [requiredInput, setRequiredInput] = useState((project.beadify?.generationSettings?.requiredColors ?? []).join(', '));
  const [useSymmetry, setUseSymmetry] = useState(project.beadify?.generationSettings?.optimization?.symmetry ?? false);
  const [samplingPhase, setSamplingPhase] = useState<[number, number]>(project.beadify?.generationSettings?.phase ?? [0, 0]);
  const [sourceFeatures, setSourceFeatures] = useState<SourceFeatureRegion[]>(project.beadify?.generationSettings?.sourceFeatures ?? []);
  const [samplingStrategy, setSamplingStrategy] = useState<NonNullable<GenerationRequest['sampling']>['strategy'] | ''>(project.beadify?.generationSettings?.sampling?.strategy ?? '');
  const [useSourceEdges, setUseSourceEdges] = useState(project.beadify?.generationSettings?.sampling?.sourceEdges ?? true);
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referenceImageUrl, setReferenceImageUrl] = useState<string | null>(null);
  const [referenceVisible, setReferenceVisible] = useState(false);
  const [referenceOpacity, setReferenceOpacity] = useState(0.35);
  const [referenceScale, setReferenceScale] = useState(1);
  const [referenceOffset, setReferenceOffset] = useState({ x: 0, y: 0 });
  const [referenceAdjusting, setReferenceAdjusting] = useState(false);
  const [referencePlacement, setReferencePlacement] = useState<ReferencePlacement>('below');
  const [canvasWidth, setCanvasWidth] = useState(project.width);
  const [canvasHeight, setCanvasHeight] = useState(project.height);
  const [convertWidth, setConvertWidth] = useState(project.beadify?.generationSettings?.width ?? defaultImportSettings.width);
  const [convertHeight, setConvertHeight] = useState(project.beadify?.generationSettings?.height ?? defaultImportSettings.width);
  const [maxColors, setMaxColors] = useState(project.beadify?.generationSettings?.maxColors ?? defaultImportSettings.maxColors);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<{ taskId: number; value: number; label: string; evaluations?: number; maxEvaluations?: number } | null>(null);
  const [notice, setNotice] = useState(text.workspaceReady);
  const [floatingHelp, setFloatingHelp] = useState<FloatingHelp | null>(null);
  const [hoverCell, setHoverCell] = useState<HoverCell | null>(null);
  const [highlightedColorId, setHighlightedColorId] = useState<string | null>(null);
  const [showIsolatedBeads, setShowIsolatedBeads] = useState(false);
  const [rightTab, setRightTab] = useState<'palette' | 'layers' | 'usage' | 'adjustments'>('palette');
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingLayerName, setEditingLayerName] = useState('');
  const [draggingLayerId, setDraggingLayerId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>(savedPaletteMode(project.beadify?.generationSettings));
  const [paletteGroup, setPaletteGroup] = useState('all');
  const [adjustments, setAdjustments] = useState<AdjustmentSettings>(defaultAdjustments);
  const [colorCleanupStrength, setColorCleanupStrength] = useState(2);
  const [layerColorLimit, setLayerColorLimit] = useState(16);
  const [past, setPast] = useState<BeadProject[]>([]);
  const [future, setFuture] = useState<BeadProject[]>([]);
  const usage = useMemo(() => summarizeUsage(project), [project]);
  const totalBeads = usage.reduce((sum, row) => sum + row.count, 0);
  const totalPacks = usage.reduce((sum, row) => sum + row.packs, 0);
  const boardCount =
    Math.ceil(project.width / project.boardSettings.boardWidth) *
    Math.ceil(project.height / project.boardSettings.boardHeight);
  const isolatedBeadRefs = useMemo(() => findIsolatedBeads(project), [project]);
  const isolatedBeads = isolatedBeadRefs.length;
  const isolatedCellIndices = useMemo(
    () => (showIsolatedBeads ? [...new Set(isolatedBeadRefs.map((item) => item.index))] : []),
    [isolatedBeadRefs, showIsolatedBeads],
  );
  const selectedColor = projectColor(project, selectedColorId);
  const activePalette = useMemo(() => (paletteMode === 'basic' ? basicPalette : completePalette).map(color => projectColor(project, color.id) ?? color), [paletteMode, project.beadify?.paletteSnapshot]);
  const currentDiagnostics = useMemo(() => ({ ...inspectCells(project.cells, project.width, project.height), ...inspectConnectivity(project.cells, project.width, project.height) }), [project.cells, project.width, project.height]);
  const recentColors = recentColorIds.flatMap((id) => {
    const color = activePalette.find((item) => item.id === id);
    return color ? [color] : [];
  });
  const paletteGroups = useMemo(
    () => [
      { id: 'all', label: 'All' },
      ...[...new Set(activePalette.map((color) => color.group))].map((group) => ({ id: group, label: group })),
    ],
    [activePalette],
  );
  const visiblePalette = useMemo(
    () => (paletteGroup === 'all' ? activePalette : activePalette.filter((color) => color.group === paletteGroup)),
    [activePalette, paletteGroup],
  );

  function displayCode(color: NonNullable<typeof selectedColor>): string {
    return color.primaryCode;
  }

  function displayName(color: NonNullable<typeof selectedColor>): string {
    return color.name;
  }

  function showFloatingHelp(anchor: HTMLElement, tooltip: string) {
    const rect = anchor.getBoundingClientRect();
    const tooltipWidth = 172;
    const left = Math.min(rect.right + 8, window.innerWidth - tooltipWidth - 10);
    setFloatingHelp({
      text: tooltip,
      left,
      top: rect.top + rect.height / 2,
    });
  }

  function imageHelpProps(tooltip: string) {
    return {
      'data-tooltip': tooltip,
      'aria-label': tooltip,
      tabIndex: 0,
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => showFloatingHelp(event.currentTarget, tooltip),
      onMouseLeave: () => setFloatingHelp(null),
      onFocus: (event: React.FocusEvent<HTMLElement>) => showFloatingHelp(event.currentTarget, tooltip),
      onBlur: () => setFloatingHelp(null),
    };
  }

  function displayCodeById(colorId: string): string {
    const color = projectColor(project, colorId);
    return color ? displayCode(color) : '';
  }

  function layerDisplayName(layer: BeadProject['layers'][number], index: number): string {
    if (layer.customName) return layer.name;
    const match = layer.name.match(/^(?:Layer|图层)\s+(\d+)$/);
    if (match) return language === 'zh' ? `图层 ${match[1]}` : `Layer ${match[1]}`;
    if (layer.id === 'base' || layer.name === 'Pattern' || layer.name === 'Base bead layer' || layer.name === '基础珠子层') {
      return systemLayerName(index);
    }
    if (!layer.name.trim()) return language === 'zh' ? `图层 ${index + 1}` : `Layer ${index + 1}`;
    return layer.name;
  }

  function systemLayerName(index: number): string {
    return language === 'zh' ? `图层 ${index + 1}` : `Layer ${index + 1}`;
  }

  function startEditingLayer(layer: BeadProject['layers'][number], index: number) {
    setEditingLayerId(layer.id);
    setEditingLayerName(layerDisplayName(layer, index));
  }

  function saveEditingLayer(layer: BeadProject['layers'][number], index: number) {
    const nextName = editingLayerName.trim();
    setEditingLayerId(null);
    if (!nextName) return;
    const isSystemName = nextName === `图层 ${index + 1}` || nextName === `Layer ${index + 1}`;
    if (isSystemName && !layer.customName) return;
    if (nextName === layer.name && layer.customName) return;
    updateLayer(layer.id, { name: nextName, customName: !isSystemName });
  }

  function layerMetaText(isActive: boolean, isVisible: boolean, isLocked: boolean, beadCount: number): string {
    const countText = text.layerBeadCount(beadCount);
    const states = [];
    if (isActive) states.push(text.activeLayer);
    if (!isVisible) states.push(text.hiddenLayer);
    if (isLocked) states.push(text.lockedLayer);
    states.push(countText);
    return states.join(' - ');
  }

  useEffect(() => {
    const saved = saveDraftWithStatus(project);
    if (!saved.saved) setNotice('自动保存失败，请导出项目 JSON 保存当前修改。');
    else if (saved.textAnalysisOmitted) setNotice('图纸和编辑已保存，但容量不足，文字分析未能自动保存。请单独导出文字分析，保留手工校正和笔画标注。');
    else if (saved.sourceRasterOmitted) setNotice('图纸和编辑已保存。受存储容量限制，原图细节记录未保存；重新打开后可选择原图恢复细节重算。');
  }, [project]);

  useEffect(() => {
    try { localStorage.setItem(languageKey, language); } catch { /* Project saving reports unavailable storage. */ }
  }, [language]);

  useEffect(() => {
    return () => {
      if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
    };
  }, [pendingImageUrl]);

  useEffect(() => {
    return () => {
      if (referenceImageUrl) URL.revokeObjectURL(referenceImageUrl);
    };
  }, [referenceImageUrl]);

  useEffect(() => {
    setCanvasWidth(project.width);
    setCanvasHeight(project.height);
  }, [project.width, project.height]);

  useEffect(() => {
    setNotice((current: string) => {
      if (current === ui.zh.workspaceReady || current === ui.en.workspaceReady) return text.workspaceReady;
      const zhGenerated = current.match(/^(\d+) 色 - (\d+) 颗 - 可编辑图案已生成。$/);
      if (zhGenerated) return `${zhGenerated[1]} colors - ${zhGenerated[2]} beads - editable pattern ready.`;
      const enGenerated = current.match(/^(\d+) colors - (\d+) beads - editable pattern ready\.$/);
      if (enGenerated) return `${enGenerated[1]} 色 - ${enGenerated[2]} 颗 - 可编辑图案已生成。`;
      return current;
    });
  }, [language, text.workspaceReady]);

  useEffect(() => {
    if (!activePalette.some((color) => color.id === selectedColorId)) {
      setSelectedColorId(activePalette[0].id);
    }
    if (!paletteGroups.some((group) => group.id === paletteGroup)) {
      setPaletteGroup('all');
    }
  }, [activePalette, paletteGroups, paletteGroup, selectedColorId]);

  useEffect(() => {
    setMaxColors(current => clampInteger(current, generationMethod === 'original' ? 2 : 1, activePalette.length));
    setLayerColorLimit(current => clampInteger(current, 2, activePalette.length));
  }, [activePalette.length, generationMethod, maxColors, layerColorLimit]);

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith('image/'));
      if (file) handleImageFile(file);
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  useEffect(() => {
    let active = true;
    setSourceImage(null);
    setSourceFileHash(null);
    if (pendingFile) decodeImage(pendingFile).then(async image => {
      const digest = sha256(new Uint8Array(await pendingFile.arrayBuffer()));
      if (!active) return;
      const saved = project.beadify?.generationSettings;
      const sameSource = saved?.sourceHash ? saved.sourceHash === digest : saved?.sourceName === pendingFile.name;
      if (!sameSource) setPreprocessing({});
      setSourceFeatures(sameSource ? saved?.sourceFeatures ?? [] : []);
      setSourceFileHash(digest); setSourceImage(image);
    }).catch(error => { if (active) setNotice(String(error)); });
    return () => { active = false; };
  }, [pendingFile]);

  useEffect(() => {
    invalidateGeneration();
    if (skipAutoGeneration.current) { skipAutoGeneration.current = false; return; }
    if (!pendingFile || !sourceImage) return;
    const timer = window.setTimeout(() => { generationTimer.current = null; void generateFromImage(); }, 420);
    generationTimer.current = timer;
    return () => { window.clearTimeout(timer); if (generationTimer.current === timer) generationTimer.current = null; };
  }, [pendingFile, sourceImage, preprocessing, convertWidth, convertHeight, maxColors, paletteMode, generationMethod, coreStyle, allowedInput, requiredInput, useSymmetry, samplingPhase, sourceFeatures, samplingStrategy, useSourceEdges, optimizationOptions, crossBinStrokes]);

  useEffect(() => () => generationWorker.current.cancel(), []);

  function clearGenerationTimer() {
    if (generationTimer.current !== null) window.clearTimeout(generationTimer.current);
    generationTimer.current = null;
  }

  function invalidateGeneration() {
    clearGenerationTimer();
    generationSession.current.invalidate();
    generationWorker.current.cancel();
    setCandidate(null);
    setPhaseCandidates([]); setTextCandidates([]);
    setIsGenerating(false); setGenerationProgress(null);
  }

  function commitHistory() {
    setPast((items) => [...items.slice(-39), project]);
    setFuture([]);
  }

  function updateProject(next: BeadProject) {
    invalidateGeneration();
    setProject({ ...next, updatedAt: new Date().toISOString() });
  }

  function selectColor(colorId: string, options: { updateRecent?: boolean } = {}) {
    setSelectedColorId(colorId);
    if (options.updateRecent === false) return;
    setRecentColorIds((current) => [colorId, ...current.filter((id) => id !== colorId)].slice(0, 7));
  }

  function activateTool(nextTool: ToolId) {
    const closingTextOptions = nextTool === 'text' && tool === 'text' && showTextOptions;
    setTool(nextTool);
    setShowPencilOptions(nextTool === 'pencil');
    setShowEraserOptions(nextTool === 'eraser');
    setShowRemoveOptions(nextTool === 'remove');
    setShowMoveOptions(nextTool === 'move');
    setShowMirrorOptions(nextTool === 'mirror');
    setShowShapeOptions(nextTool === 'shape');
    setShowTextOptions(nextTool === 'text' && !closingTextOptions);
    setShowClipboardOptions(nextTool === 'copy' || nextTool === 'paste');
    setShowPanOptions(nextTool === 'pan');
  }

  function updateCells(cells: Array<string | null>) {
    updateProject(withCells(project, cells));
  }

  function resetImportSettings() {
    setConvertWidth(defaultImportSettings.width);
    setConvertHeight(defaultImportSettings.width);
    setPreprocessing({}); setAllowedInput(''); setRequiredInput(''); setUseSymmetry(false);
    setSamplingPhase([0, 0]); setSourceFeatures([]);
    setSamplingStrategy(''); setUseSourceEdges(true);
    setMaxColors(defaultImportSettings.maxColors);
  }

  function resetReferenceTransform() {
    setReferenceScale(1);
    setReferenceOffset({ x: 0, y: 0 });
    setReferenceAdjusting(false);
  }

  function resetAdjustments() {
    const session = adjustmentSessionRef.current;
    if (session.layerId === activeLayer.id && session.baseCells.length === activeLayer.cells.length) {
      updateProject(withLayers(project, layers.map((layer) => (layer.id === activeLayer.id ? { ...layer, cells: session.baseCells.slice() } : layer))));
    }
    setAdjustments(defaultAdjustments);
    adjustmentSessionRef.current = { layerId: null, baseCells: [] };
  }

  function updateAdjustment(key: keyof AdjustmentSettings, value: number) {
    if (activeLayer.locked) {
      setNotice(text.adjustmentLocked);
      return;
    }
    const nextAdjustments = { ...adjustments, [key]: value };
    if (adjustmentSessionRef.current.layerId !== activeLayer.id) {
      adjustmentSessionRef.current = { layerId: activeLayer.id, baseCells: activeLayer.cells.slice() };
      commitHistory();
    }
    const baseCells = adjustmentSessionRef.current.baseCells.length > 0 ? adjustmentSessionRef.current.baseCells : activeLayer.cells;
    const adjustedCells = adjustLayerCells(baseCells, nextAdjustments, activePalette);
    setAdjustments(nextAdjustments);
    updateProject(withLayers(project, layers.map((layer) => (layer.id === activeLayer.id ? { ...layer, cells: adjustedCells } : layer))));
  }

  function applyColorCleanup() {
    if (activeLayer.locked) {
      setNotice(text.adjustmentLocked);
      return;
    }
    const { cells, changed } = mergeCloseLayerColors(activeLayer.cells, activePalette, colorCleanupStrength);
    if (changed > 0) {
      commitHistory();
      updateProject(withLayers(project, layers.map((layer) => (layer.id === activeLayer.id ? { ...layer, cells } : layer))));
    }
    setNotice(text.layerColorsCleaned(changed));
  }

  function applyLayerColorLimit() {
    if (activeLayer.locked) {
      setNotice(text.adjustmentLocked);
      return;
    }
    const { cells, changed } = limitLayerColors(activeLayer.cells, activePalette, layerColorLimit);
    if (changed > 0) {
      commitHistory();
      updateProject(withLayers(project, layers.map((layer) => (layer.id === activeLayer.id ? { ...layer, cells } : layer))));
    }
    setNotice(text.layerColorsLimited(changed, layerColorLimit));
  }

  function applyLayerEffect(effect: LayerEffect, label: string) {
    if (activeLayer.locked) {
      setNotice(text.adjustmentLocked);
      return;
    }
    const { cells, changed } = applyEffectToLayer(activeLayer.cells, activePalette, effect);
    if (changed > 0) {
      commitHistory();
      updateProject(withLayers(project, layers.map((layer) => (layer.id === activeLayer.id ? { ...layer, cells } : layer))));
    }
    setNotice(text.effectApplied(label, changed));
  }

  function replaceColor(sourceColorId: string) {
    if (!sourceColorId || sourceColorId === selectedColorId) return;
    let changed = 0;
    const visibleLayerIds = new Set(displayProject.layers.filter((layer) => layer.visible).map((layer) => layer.id));
    const nextLayers = layers.map((layer) => {
      if (layer.locked || !visibleLayerIds.has(layer.id)) return layer;
      let layerChanged = false;
      const cells = layer.cells.map((cell) => {
        if (cell !== sourceColorId) return cell;
        changed += 1;
        layerChanged = true;
        return selectedColorId;
      });
      return layerChanged ? { ...layer, cells } : layer;
    });
    if (changed === 0) return;
    commitHistory();
    updateProject(withLayers(project, nextLayers, project.activeLayerId));
    setNotice(text.recoloredBeads(changed));
  }

  function undo() {
    const previous = past[past.length - 1];
    if (!previous) return;
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [...items, project]);
    restoreSceneControls(previous);
    updateProject(previous);
  }

  function redo() {
    const next = future[future.length - 1];
    if (!next) return;
    setFuture((items) => items.slice(0, -1));
    setPast((items) => [...items, project]);
    restoreSceneControls(next);
    updateProject(next);
  }

  function startBlank(width = 52, height = 52) {
    soloVisibilitySnapshotRef.current = null;
    updateProject(createProject(width, height));
    setPast([]);
    setFuture([]);
    setClipboardPattern(null);
    setCopySelectionIndices([]);
    resetAdjustments();
    resetImportSettings();
    setSelectedColorId(defaultColorId);
    setRecentColorIds(defaultRecentColorIds);
    setPaletteGroup('all');
    setPendingFile(null);
    setPendingImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setReferenceFile(null);
    setReferenceImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setReferenceVisible(false);
    resetReferenceTransform();
    setNotice(language === 'zh' ? `已创建 ${width} * ${height} 空白画布。` : `Blank ${width} x ${height} canvas created.`);
  }

  function clearCanvas() {
    if (activeLayer.locked) return;
    if (activeLayer.cells.every((cell) => cell === null)) return;
    commitHistory();
    updateProject(withCells(project, Array.from({ length: project.width * project.height }, () => null)));
    setNotice(language === 'zh' ? '画布已清空。' : 'Canvas cleared.');
  }

  function resizeCanvas() {
    const width = clampInteger(canvasWidth, 8, 180);
    const height = clampInteger(canvasHeight, 8, 180);
    if (width === project.width && height === project.height) return;

    commitHistory();
    const nextLayers = layers.map((layer) => ({
      ...layer,
      cells: resizeCells(layer.cells, project.width, project.height, width, height),
    }));
    updateProject({
      ...project,
      width,
      height,
      layers: nextLayers,
      cells: composeVisibleCells(nextLayers, width, height),
      ...(project.beadify ? { beadify: { ...project.beadify, constraints: remapConstraints(project.beadify.constraints ?? [], project.width, width, height), ...(project.beadify.sourceRaster ? { sourceRaster: resizeSourceRaster(project.beadify.sourceRaster, width, height) } : {}) } } : {}),
    });
    setNotice(language === 'zh' ? `画布已调整为 ${width} * ${height}。` : `Canvas resized to ${width} x ${height}.`);
  }

  function applyPreset(value: string) {
    const preset = sizePresets.find((item) => item.label === value);
    if (!preset) return;
    setCanvasWidth(preset.width);
    setCanvasHeight(preset.height);
  }

  function handleImageFile(file: File) {
    if (!file.type.match(/^image\/(png|jpeg|jpg|webp)$/)) {
      setNotice(language === 'zh' ? '请使用 PNG、JPG、JPEG 或 WebP 图片。' : 'Use a PNG, JPG, JPEG, or WebP image.');
      return;
    }
    setSourceImage(null);
    setPendingFile(file);
    setPendingImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    setReferenceFile(file);
    setReferenceImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    resetReferenceTransform();
    invalidateGeneration();
    setNotice(language === 'zh' ? `正在生成 ${file.name}...` : `Generating ${file.name}...`);
  }

  function handleReferenceImageFile(file: File) {
    if (!file.type.match(/^image\/(png|jpeg|jpg|webp)$/)) {
      setNotice(language === 'zh' ? '请使用 PNG、JPG、JPEG 或 WebP 图片。' : 'Use a PNG, JPG, JPEG, or WebP image.');
      return;
    }
    setReferenceFile(file);
    setReferenceImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    resetReferenceTransform();
    setReferenceVisible(true);
    setNotice(language === 'zh' ? `${file.name} 已设为参考图。` : `${file.name} set as reference image.`);
  }

  function generationPalette() {
    const fresh = workspacePalette(activePalette), saved = project.beadify?.paletteSnapshot;
    return loadPalette({ ...(saved ?? fresh), colors: fresh.colors.map(color => saved?.colors.find(previous => previous.brand === color.brand && previous.code === color.code) ?? color) });
  }

  function completeProjectPalette() {
    const next = generationPalette();
    const colors = new Map((project.beadify?.paletteSnapshot.colors ?? []).map(color => [`${color.brand}:${color.code}`, color]));
    next.colors.forEach(color => colors.set(`${color.brand}:${color.code}`, color));
    return loadPalette({ ...next, colors: [...colors.values()] });
  }

  function generationSettings(): SavedGenerationSettings {
    const palette = generationPalette();
    const allowedColors = parseColorCodes(allowedInput, palette);
    const requiredColors = parseColorCodes(requiredInput, palette);
    return {
      method: generationMethod, width: convertWidth, height: convertHeight, maxColors, style: coreStyle,
      preprocessing, sourceName: pendingFile?.name ?? project.beadify?.generationSettings?.sourceName ?? '',
      ...(sourceFileHash ? { sourceHash: sourceFileHash } : {}),
      allowedColors: (allowedColors.length ? allowedColors : palette.colors.map(color => color.id)) as NonNullable<GenerationRequest['allowedColors']>,
      ...(generationMethod !== 'original' ? { phase: samplingPhase } : {}),
      ...((generationMethod === 'dominant' || generationMethod === 'optimized') && (samplingStrategy || !useSourceEdges || !crossBinStrokes) ? { sampling: { ...(samplingStrategy ? { strategy: samplingStrategy } : {}), ...(!useSourceEdges ? { sourceEdges: false } : {}), ...(!crossBinStrokes ? { crossBinStrokes: false } : {}) } } : {}),
      ...(generationMethod === 'optimized' ? { requiredColors, optimization: { ...optimizationOptions, symmetry: useSymmetry }, ...(sourceFeatures.length ? { sourceFeatures } : {}) } : {}),
    };
  }

  function reportGeneration(ticket: GenerationTicket, value: number, label: string, detail?: CoreProgress) {
    if (!generationSession.current.isCurrent(ticket)) return;
    setGenerationProgress(previous => ({ taskId: ticket.taskId, value: Math.min(100, Math.max(previous?.taskId === ticket.taskId ? previous.value : 0, value)), label,
      evaluations: detail?.evaluations, maxEvaluations: detail?.maxEvaluations }));
  }

  function generationReporter(ticket: GenerationTicket, offset = 0, span = 100, prefix = '') {
    const labels: Record<CoreProgress['stage'], string> = { sampling: '采样原图与结构细节', optimizing: '优化颜色与形状', finalizing: '整理图纸和用量', 'text-evidence': '分析文字笔画结构', 'source-cache': '整理原图细节缓存', 'text-extraction': '提取原图文字笔画', complete: '当前步骤完成' };
    return (progress: CoreProgress) => reportGeneration(ticket, offset + span * progress.completed / progress.total, prefix + labels[progress.stage], progress);
  }

  async function buildPhotoCandidate(settings: SavedGenerationSettings, ticket: GenerationTicket, offset = 0, span = 100, prefix = ''): Promise<GenerationCandidate> {
      reportGeneration(ticket, offset, prefix + '准备原图');
      if (!sourceImage || !sourceFileHash) throw new Error('原图尚未加载完成。');
      const image = sourceImage, sourceHash = sourceFileHash;
      const { sourceName: _sourceName, sourceHash: _sourceHash, method, ...config } = settings;
      if (!Number.isInteger(convertWidth) || !Number.isInteger(convertHeight) || convertWidth < 1 || convertWidth > 256 || convertHeight < 1 || convertHeight > 256) throw new Error('输出每边须为1–256格');
      let result: ConvertResult;
      let pattern: BeadPattern | undefined;
      if (method === 'original') {
        const prepared = prepareImage(image, preprocessing);
        const file = await originalInputFile(preprocessing.smoothing && coreStyle !== 'pixel-input' ? smoothImage(prepared.image) : prepared.image, convertWidth, convertHeight);
        if (!generationSession.current.isCurrent(ticket)) throw new Error('Generation cancelled');
        const palette = generationPalette();
        const allowed = new Set(settings.allowedColors ?? palette.colors.map(c => c.id));
        const allowedCodes = new Set(palette.colors.filter(c => allowed.has(c.id)).map(c => c.code));
        result = await imageFileToBeads(file, { width: convertWidth, maxColors, palette: activePalette.filter(c => allowedCodes.has(c.primaryCode)), generationStyle: coreStyle === 'accurate' ? 'realistic' : 'cartoon', backgroundMode: 'keep', backgroundColor: [255, 255, 255], tolerance: 0, speckleReduction: 0 }, phase => {
          if (!generationSession.current.isCurrent(ticket)) throw new Error('Generation cancelled');
          const stages = { decoding: [0, '解码原图'], sampling: [1, '采样原图'], palette: [2, '选择图纸色卡'], finalizing: [3, '整理图纸'] } as const;
          reportGeneration(ticket, offset + span * .75 * stages[phase][0] / 4, prefix + stages[phase][1]);
        });
      } else {
        pattern = await generationWorker.current.generate({ schemaVersion: 1, revision: ticket.revision, image, palette: generationPalette(), method, ...config }, generationReporter(ticket, offset, span * .75, prefix));
        result = workspaceResult(pattern);
      }
      if (!generationSession.current.isCurrent(ticket)) throw new Error('Generation cancelled');
      const sourceRaster = await generationWorker.current.prepareSource({ schemaVersion: 1, revision: ticket.revision, image, palette: generationPalette(), method: method === 'original' ? 'dominant' : method, ...config, width: result.width, height: result.height }, sourceHash, generationReporter(ticket, offset + span * .75, span * .25, prefix));
      if (!generationSession.current.isCurrent(ticket)) throw new Error('Generation cancelled');
      return { ticket, result, pattern, mode: 'generate', settings, sourceRaster };
  }

  async function generateFromImage() {
    clearGenerationTimer();
    if (!pendingFile || !sourceImage) return;
    const ticket = generationSession.current.begin();
    generationWorker.current.cancel(); setCandidate(null); setPhaseCandidates([]); setTextCandidates([]); setIsGenerating(true); reportGeneration(ticket, 0, '准备生成任务');
    setNotice('正在本地生成候选图案…');
    try {
      const next = await buildPhotoCandidate(generationSettings(), ticket);
      if (!generationSession.current.isCurrent(ticket)) return;
      setCandidate(next);
      setNotice('候选已就绪；接受后显示新图层，旧图层保留并隐藏。');
    } catch (error) {
      if (generationSession.current.isCurrent(ticket)) setNotice(error instanceof Error ? error.message : 'Generation failed');
    } finally { if (generationSession.current.isCurrent(ticket)) setIsGenerating(false); }
  }

  function changeTextAnalysis(value: TextAnalysis | undefined) {
    commitHistory();
    const metadata = { ...project.beadify, schemaVersion: 1 as const, paletteSnapshot: completeProjectPalette(),
      lastGeneration: project.beadify?.lastGeneration ?? { method: 'original' as const, inputRevision: 0, configHash: null } };
    if (value) metadata.textAnalysis = value; else delete metadata.textAnalysis;
    delete metadata.textAnalysisOmission;
    updateProject({ ...project, beadify: metadata });
  }

  function restoreSceneControls(next: BeadProject) {
    if (!project.beadify?.sceneAnalysis && !next.beadify?.sceneAnalysis) return;
    const settings = next.beadify?.generationSettings;
    if (settings?.sourceHash && settings.sourceHash === sourceFileHash) {
      setPreprocessing(settings.preprocessing ?? {}); setSourceFeatures(settings.sourceFeatures ?? []); setGenerationMethod(settings.method);
    }
  }

  async function compareTextCandidates(layout?: TextRetype) {
    const analysis = project.beadify?.textAnalysis;
    if (!sourceImage || !analysis || !matchingText(analysis, sourceImage)) return;
    clearGenerationTimer();
    const ticket = generationSession.current.begin();
    generationWorker.current.cancel(); setCandidate(null); setPhaseCandidates([]); setTextCandidates([]); setIsGenerating(true); reportGeneration(ticket, 0, '准备生成任务');
    setNotice('正在生成普通候选，然后从原图提取文字笔画并增强…');
    try {
      const settings: SavedGenerationSettings = { ...generationSettings(), method: 'optimized', optimization: { ...optimizationOptions, symmetry: useSymmetry },
        requiredColors: parseColorCodes(requiredInput, generationPalette()) as NonNullable<GenerationRequest['requiredColors']>,
        phase: samplingPhase, sourceFeatures, sampling: { ...(samplingStrategy ? { strategy: samplingStrategy } : {}), sourceEdges: useSourceEdges, crossBinStrokes } };
      if (settings.style === 'pixel-input') throw new Error('原图已是像素画模式不执行文字增强，请选择其他图纸风格。');
      const stepSpan = 100 / (layout ? 3 : 2);
      const ordinary = await buildPhotoCandidate(settings, ticket, 0, stepSpan, '普通候选 · ');
      if (!generationSession.current.isCurrent(ticket)) return;
      const { sourceName: _name, sourceHash: _hash, method: _method, ...config } = settings;
      const request: GenerationRequest = { schemaVersion: 1, revision: ticket.revision, image: sourceImage, palette: generationPalette(), method: 'optimized', ...config };
      setNotice('正在从原图提取文字笔画并生成增强候选…');
      const result = await generationWorker.current.generateText(request, analysis, ordinary.pattern, true, generationReporter(ticket, stepSpan, stepSpan, '文字增强 · '));
      if (!generationSession.current.isCurrent(ticket)) return;
      const baseline = { ...ordinary, label: '普通候选' }, enhanced = { ...ordinary, label: '文字增强', pattern: result.pattern, result: workspaceResult(result.pattern), textResult: result };
      if (layout) {
        reportGeneration(ticket, stepSpan * 2, '修复文字背景并重新排字');
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!generationSession.current.isCurrent(ticket)) return;
        const rendered = await retypeTextPattern(ordinary.pattern!, result.analysis ?? analysis, layout, request);
        if (!generationSession.current.isCurrent(ticket)) return;
        const retyped: GenerationCandidate = { ...ordinary, label: '重新排字', pattern: rendered.pattern, result: workspaceResult(rendered.pattern), textRetype: layout,
          retypeInfo: { changedCells: rendered.changedCells.length, fontSize: rendered.fontSize } };
        reportGeneration(ticket, 100, '三份候选已完成');
        setTextCandidates([baseline, enhanced, retyped]); setCandidate(retyped);
        setNotice(`重排完成，自动字号约 ${rendered.fontSize.toFixed(1)} 格；修改 ${rendered.changedCells.length} 格。接受后可撤销。`);
        return;
      }
      setTextCandidates([baseline, enhanced]); setCandidate(enhanced);
      setNotice(result.status === 'UNCHANGED' ? '没有找到可安全增强的文字细节，保留普通候选。请检查区域或手动标注笔画与背景。' : `文字增强完成，修改 ${result.changedCells.length} 格。请选择候选，接受后可撤销。`);
    } catch (error) { if (generationSession.current.isCurrent(ticket)) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (generationSession.current.isCurrent(ticket)) setIsGenerating(false); }
  }

  async function compareSamplingPhases() {
    clearGenerationTimer();
    if (!sourceImage || generationMethod === 'original') return;
    const ticket = generationSession.current.begin();
    generationWorker.current.cancel(); setCandidate(null); setPhaseCandidates([]); setTextCandidates([]); setIsGenerating(true); reportGeneration(ticket, 0, '准备生成任务');
    try {
      const settings = generationSettings(), results: GenerationCandidate[] = [];
      for (const phase of SAMPLING_PHASES) {
        setNotice(`正在比较网格位置 ${results.length + 1} / ${SAMPLING_PHASES.length}…`);
        results.push(await buildPhotoCandidate({ ...settings, phase: phase.value }, ticket, results.length * 100 / SAMPLING_PHASES.length, 100 / SAMPLING_PHASES.length, `网格候选 ${results.length + 1} / ${SAMPLING_PHASES.length} · `));
        if (!generationSession.current.isCurrent(ticket)) return;
      }
      setPhaseCandidates(results);
      setCandidate(results.find(result => result.settings.phase?.every((value, index) => value === samplingPhase[index])) ?? results[0]);
      setNotice('五个网格位置已就绪；选择保留细节较好的版本后接受。');
    } catch (error) { if (generationSession.current.isCurrent(ticket)) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (generationSession.current.isCurrent(ticket)) setIsGenerating(false); }
  }

  async function recalculateRegion(indices: number[], source: 'source' | 'pattern') {
    if (!indices.length) return;
    clearGenerationTimer();
    const ticket = generationSession.current.begin();
    setCandidate(null); setPhaseCandidates([]); setTextCandidates([]); setIsGenerating(true); reportGeneration(ticket, 0, '准备生成任务');
    try {
      const palette = generationPalette();
      const allowedColors = parseColorCodes(allowedInput, palette);
      const requiredColors = parseColorCodes(requiredInput, palette);
      const settings: SavedGenerationSettings = { method: 'optimized', width: project.width, height: project.height, maxColors, style: coreStyle, sourceName: 'current-pattern', allowedColors: (allowedColors.length ? allowedColors : palette.colors.map(color => color.id)) as NonNullable<GenerationRequest['allowedColors']>, requiredColors, optimization: { ...optimizationOptions, symmetry: useSymmetry } };
      const { sourceName: _sourceName, sourceHash: _sourceHash, method: _method, ...config } = settings;
      const request = source === 'source' ? { ...sourceRoiRequest(project, palette, indices, config), revision: ticket.revision }
        : { schemaVersion: 1 as const, revision: ticket.revision, image: currentRaster(project), palette, method: 'optimized' as const, ...config, constraints: roiConstraints(project, palette, indices) };
      const pattern = await generationWorker.current.generate(request, generationReporter(ticket, 0, 100, '局部重算 · '));
      if (!generationSession.current.isCurrent(ticket)) return;
      setCandidate({ ticket, result: workspaceResult(pattern), pattern, mode: 'roi', settings });
      setNotice('选区重算已完成；选区外锁定。接受后生效。');
    } catch (error) { if (generationSession.current.isCurrent(ticket)) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (generationSession.current.isCurrent(ticket)) setIsGenerating(false); }
  }

  function updateConstraints(constraints: CellConstraint[]) {
    commitHistory();
    updateProject({ ...project, beadify: { ...project.beadify, schemaVersion: 1, paletteSnapshot: completeProjectPalette(), lastGeneration: project.beadify?.lastGeneration ?? { method: 'original', inputRevision: 0, configHash: null }, constraints } });
  }

  function acceptCandidate() {
    if (!candidate || !generationSession.current.isCurrent(candidate.ticket)) return;
    const { result, pattern } = candidate;
    const hasExisting = layers.some(layer => layer.cells.some(cell => cell !== null));
    const width = candidate.mode === 'roi' ? project.width : hasExisting ? Math.max(project.width, result.width) : result.width;
    const height = candidate.mode === 'roi' ? project.height : hasExisting ? Math.max(project.height, result.height) : result.height;
    const nextLayers = layers.map(layer => ({ ...layer, visible: false, cells: resizeCells(layer.cells, project.width, project.height, width, height) }));
    const added = createLayer(width, height, `Beadify ${candidate.label ?? candidate.settings.method}`);
    added.cells = resizeCells(result.cells, result.width, result.height, width, height); nextLayers.push(added);
    if (candidate.mode === 'generate' && candidate.settings.method !== generationMethod) {
      skipAutoGeneration.current = true; setGenerationMethod(candidate.settings.method);
    }
    if (candidate.mode === 'generate' && candidate.settings.phase && !candidate.settings.phase.every((value, index) => value === samplingPhase[index])) {
      skipAutoGeneration.current = true; setSamplingPhase(candidate.settings.phase);
    }
    commitHistory();
    updateProject({ ...project, width, height, layers: nextLayers, activeLayerId: added.id, cells: composeVisibleCells(nextLayers, width, height), beadify: {
      schemaVersion: 1, paletteSnapshot: completeProjectPalette(),
      ...(project.beadify?.sceneAnalysis ? { sceneAnalysis: project.beadify.sceneAnalysis } : {}),
      ...(candidate.textResult?.analysis ? { textAnalysis: candidate.textResult.analysis } : project.beadify?.textAnalysis ? { textAnalysis: project.beadify.textAnalysis } : project.beadify?.textAnalysisOmission ? { textAnalysisOmission: project.beadify.textAnalysisOmission } : {}),
      ...(candidate.textRetype ? { textRetype: candidate.textRetype } : project.beadify?.textRetype ? { textRetype: project.beadify.textRetype } : {}),
      lastGeneration: { method: candidate.settings.method, inputRevision: candidate.ticket.revision, configHash: pattern?.configHash ?? null },
      generationSettings: candidate.mode === 'roi' ? project.beadify?.generationSettings ?? candidate.settings : candidate.settings,
      constraints: candidate.mode === 'roi' ? project.beadify?.constraints ?? [] : [],
      ...(candidate.mode === 'roi' ? project.beadify?.sourceRaster ? { sourceRaster: project.beadify.sourceRaster } : {} : candidate.sourceRaster ? { sourceRaster: resizeSourceRaster(candidate.sourceRaster, width, height) } : {}),
      ...(candidate.mode === 'roi' && !project.beadify?.sourceRaster && project.beadify?.sourceRasterOmission ? { sourceRasterOmission: project.beadify.sourceRasterOmission } : {}),
    } });
    setCanvasWidth(width); setCanvasHeight(height);
    setNotice('已显示候选图层。旧图层已隐藏，可撤销或在图层中恢复。');
  }

  function exportVisibleBom() { downloadUsageCsv(project); }

  async function importJson(file: File) {
    if (file.size > 20 * 1024 * 1024) throw new Error('Project JSON exceeds 20 MiB');
    let imported: BeadProject;
    try {
      const text = await file.text();
      imported = JSON.parse(text) as BeadProject;
    } catch {
      throw new Error(text.unreadableRecord);
    }
    if (!imported.width || !imported.height || !Array.isArray(imported.cells)) {
      throw new Error(text.invalidRecord);
    }
    soloVisibilitySnapshotRef.current = null;
    const restored = normalizeProject(imported);
    updateProject(restored);
    const settings = restored.beadify?.generationSettings;
    setSamplingStrategy(settings?.sampling?.strategy ?? ''); setUseSourceEdges(settings?.sampling?.sourceEdges ?? true);
    setOptimizationOptions(settings?.optimization ?? {}); setCrossBinStrokes(settings?.sampling?.crossBinStrokes ?? true);
    if (settings) {
      setGenerationMethod(settings.method); setConvertWidth(settings.width); setConvertHeight(settings.height); setMaxColors(settings.maxColors);
      setPreprocessing(settings.preprocessing ?? {}); setCoreStyle(settings.style ?? 'clean');
      setSamplingPhase(settings.phase ?? [0, 0]); setSourceFeatures(settings.sourceFeatures ?? []);
      setAllowedInput(savedAllowedInput(settings)); setPaletteMode(savedPaletteMode(settings)); setRequiredInput((settings.requiredColors ?? []).join(', ')); setUseSymmetry(settings.optimization?.symmetry ?? false);
    }
    setCanvasWidth(restored.width); setCanvasHeight(restored.height);
    setPast([]);
    setFuture([]);
    setPendingFile(null);
    setPendingImageUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setNotice(restored.beadify?.textAnalysisOmission ? '编辑记录已导入。文件未包含文字分析；可导入单独的分析记录或重新分析原图。' : restored.beadify?.sourceRasterOmission ? '编辑记录已导入。文件未包含原图细节记录；选择原图可恢复细节重算。' : text.recordImported);
  }

  function exportUsageList() {
    downloadUsageWorkbook(project);
    setNotice(text.usageExported);
  }

  function exportEditRecord() {
    try {
      const saved = downloadProjectJson(project);
      setNotice(saved.textAnalysisOmitted ? '图纸和编辑已导出。受文件容量限制，文字分析未附带；请单独导出文字分析保留标注。' : saved.sourceRasterOmitted ? '编辑记录已导出。为控制文件大小，未附带原图细节记录；图纸、图层和规则均已保留。' : text.recordExported);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  function resetClipboard() {
    setClipboardPattern(null);
    setCopySelectionIndices([]);
    setNotice(text.clipboardReset);
  }

  function addLayer() {
    commitHistory();
    const nextLayer = createLayer(project.width, project.height, `${text.layers} ${layers.length + 1}`);
    updateProject(withLayers(project, [...layers, nextLayer], nextLayer.id));
  }

  function duplicateLayer(layerId: string) {
    const sourceIndex = layers.findIndex((layer) => layer.id === layerId);
    const source = layers[sourceIndex];
    if (!source) return;
    commitHistory();
    const displayName = layerDisplayName(source, sourceIndex);
    const nextLayer = {
      ...source,
      id: `layer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: uniqueDuplicateLayerName(displayName),
      customName: true,
      locked: false,
      cells: source.cells.slice(),
    };
    const nextLayers = layers.slice();
    nextLayers.splice(sourceIndex + 1, 0, nextLayer);
    updateProject(withLayers(project, nextLayers, nextLayer.id));
  }

  function uniqueDuplicateLayerName(baseName: string): string {
    const suffix = language === 'zh' ? '复制' : 'copy ';
    const existingNames = new Set(layers.map((layer, index) => layerDisplayName(layer, index)));
    for (let index = 1; index < 1000; index += 1) {
      const candidate = language === 'zh' ? `${baseName}-${suffix}${index}` : `${baseName}-${suffix}${index}`;
      if (!existingNames.has(candidate)) return candidate;
    }
    return language === 'zh' ? `${baseName}-${suffix}${Date.now()}` : `${baseName}-${suffix}${Date.now()}`;
  }

  function updateLayer(layerId: string, changes: Partial<BeadProject['layers'][number]>) {
    commitHistory();
    updateProject(withLayers(project, layers.map((layer) => (layer.id === layerId ? { ...layer, ...changes } : layer))));
  }


  function toggleActiveLayerOnly() {
    const shouldEnable = !project.settings.showActiveLayerOnly;
    if (shouldEnable) {
      soloVisibilitySnapshotRef.current = Object.fromEntries(layers.map((layer) => [layer.id, layer.visible]));
      const soloLayers = layers.map((layer) => ({
        ...layer,
        visible: layer.id === activeLayer.id,
      }));
      updateProject({
        ...project,
        settings: { ...project.settings, showActiveLayerOnly: true },
        layers: soloLayers,
        cells: composeVisibleCells(soloLayers, project.width, project.height),
      });
      return;
    }

    const snapshot = soloVisibilitySnapshotRef.current;
    soloVisibilitySnapshotRef.current = null;
    const restoredLayers = layers.map((layer) => ({
      ...layer,
      visible: snapshot?.[layer.id] ?? layer.visible,
    }));
    updateProject({
      ...project,
      settings: { ...project.settings, showActiveLayerOnly: false },
      layers: restoredLayers,
      cells: composeVisibleCells(restoredLayers, project.width, project.height),
    });
  }

  function deleteLayer(layerId: string) {
    if (layers.length <= 1) return;
    commitHistory();
    updateProject(withLayers(project, layers.filter((layer) => layer.id !== layerId)));
  }

  function moveLayer(sourceId: string, target: DragTarget) {
    if (sourceId === target.id) return;
    const originalDisplayLayers = [...layers].reverse();
    const nextDisplayLayers = originalDisplayLayers.slice();
    const sourceIndex = nextDisplayLayers.findIndex((layer) => layer.id === sourceId);
    if (sourceIndex < 0) return;
    const [movedLayer] = nextDisplayLayers.splice(sourceIndex, 1);
    const targetIndex = nextDisplayLayers.findIndex((layer) => layer.id === target.id);
    if (targetIndex < 0) return;
    const insertIndex = target.edge === 'after' ? targetIndex + 1 : targetIndex;
    nextDisplayLayers.splice(insertIndex, 0, movedLayer);
    const originalOrder = originalDisplayLayers.map((layer) => layer.id).join('|');
    const nextOrder = nextDisplayLayers.map((layer) => layer.id).join('|');
    if (originalOrder === nextOrder) return;
    commitHistory();
    updateProject(withLayers(project, nextDisplayLayers.reverse(), project.activeLayerId));
  }

  function dragTargetFromEvent(event: React.DragEvent<HTMLElement>, layerId: string): DragTarget {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      id: layerId,
      edge: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
    };
  }

  function selectLayer(layerId: string) {
    if (!project.settings.showActiveLayerOnly) {
      updateProject({ ...project, activeLayerId: layerId });
      return;
    }
    const soloLayers = layers.map((layer) => ({
      ...layer,
      visible: layer.id === layerId,
    }));
    updateProject({
      ...project,
      activeLayerId: layerId,
      layers: soloLayers,
      cells: composeVisibleCells(soloLayers, project.width, project.height),
    });
  }

  function setBeadsPerPack(value: number) {
    updateProject({
      ...project,
      settings: {
        ...project.settings,
        beadsPerPack: clampInteger(value, 1, 10000),
      },
    });
  }


  function stepBeadsPerPack(direction: -1 | 1) {
    const current = project.settings.beadsPerPack;
    const step = 500;
    const next =
      direction > 0
        ? current % step === 0
          ? current + step
          : Math.ceil(current / step) * step
        : current % step === 0
          ? current - step
          : Math.floor(current / step) * step;
    setBeadsPerPack(Math.max(step, next));
  }

  const layers = project.layers?.length ? project.layers : createProject(project.width, project.height).layers;
  const activeLayer = layers.find((layer) => layer.id === project.activeLayerId) ?? layers[0];
  useEffect(() => {
    setCopySelectionIndices([]);
    setAdjustments(defaultAdjustments);
    adjustmentSessionRef.current = { layerId: null, baseCells: [] };
  }, [activeLayer.id, project.width, project.height]);
  const displayProject = useMemo(() => {
    if (!project.settings.showActiveLayerOnly) {
      return project;
    }
    const displayLayers = layers.map((layer) => ({
      ...layer,
      visible: layer.id === activeLayer.id,
    }));
    return {
      ...project,
      layers: displayLayers,
      cells: composeVisibleCells(displayLayers, project.width, project.height),
    };
  }, [activeLayer.id, layers, project]);
  const shapeLabel = {
    line: text.shapeLine,
    rectangle: text.shapeRectangle,
    square: text.shapeSquare,
    ellipse: text.shapeEllipse,
    circle: text.shapeCircle,
    triangle: text.shapeTriangle,
    arrow: text.shapeArrow,
  } satisfies Record<ShapeKind, string>;
  const arrowLabel = {
    single: text.arrowSingle,
    double: text.arrowDouble,
    block: text.arrowBlock,
  } satisfies Record<ArrowKind, string>;
  const selectedSizePreset = sizePresets.find((item) => item.width === canvasWidth && item.height === canvasHeight)?.label ?? '';
  const defaultPrintNickname = useMemo(() => {
    const date = new Date();
    const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
    return language === 'zh' ? `拼豆图纸_${stamp}` : `Perler_Beads_${stamp}`;
  }, [language]);

  async function exportPrintPattern() {
    const options = { ...printExportOptions, projectName: printExportOptions.projectName?.trim() || defaultPrintNickname };
    try {
      if (options.format === 'pdf') await downloadPrintPdf(project, options);
      else if (options.format === 'svg') downloadPrintSvg(project, options);
      else if (options.format === 'preview') await downloadPreviewPng(project, options);
      else await downloadPrintPng(project, options);
      setShowPrintExportPanel(false);
      setNotice('已导出当前可见图纸。PDF请按100%打印并核对校准尺。');
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  return (
    <main
      className="app-shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('image/'));
        if (file) handleImageFile(file);
      }}
    >
      <input
        data-testid="generation-file" ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) handleImageFile(file);
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={referenceInputRef}
        className="hidden-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) handleReferenceImageFile(file);
          event.currentTarget.value = '';
        }}
      />
      <input
        data-testid="project-file" ref={jsonInputRef}
        className="hidden-input"
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) importJson(file).catch((error) => setNotice(error.message));
          event.currentTarget.value = '';
        }}
      />

      <header className="topbar">
        <div className="brand-lockup" aria-label="Perler Beads Generator">
          <span className="logo-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <div>
            <strong>{text.appName}</strong>
            <small>
              {text.status(project.width, project.height, totalBeads, usage.length)}
            </small>
          </div>
        </div>

        <div className="topbar-workspace">
          <div className="topbar-params canvas-params" aria-label="Canvas controls">
            <span className="topbar-control-label">{text.board}</span>
            <div className="topbar-dimension-group">
              <input aria-label="Canvas width" type="number" min={8} max={180} value={canvasWidth} onChange={(event) => setCanvasWidth(Number(event.target.value))} />
              <span className="size-times">×</span>
              <input aria-label="Canvas height" type="number" min={8} max={180} value={canvasHeight} onChange={(event) => setCanvasHeight(Number(event.target.value))} />
            </div>
            <select className="canvas-preset-select" aria-label="Canvas preset" value={selectedSizePreset || ''} onChange={(event) => applyPreset(event.target.value)}>
              <option value="" disabled hidden>{text.commonSizes}</option>
              {sizePresets.map((preset) => (
                <option key={preset.label} value={preset.label}>{preset.label}</option>
              ))}
            </select>
            <button className="canvas-apply-button" onClick={resizeCanvas}>{text.apply}</button>
          </div>

          <div className="topbar-command-zone">
            <div className="topbar-actions project-actions">
              <button className="project-action-button primary-action" onClick={() => startBlank(52, 52)}>{text.new}</button>
              <button className="project-action-button" onClick={clearCanvas}>{text.clear}</button>
              <span className="project-action-divider" aria-hidden="true" />
              <button className="project-action-button history-action" onClick={undo} disabled={past.length === 0}>{text.undo}</button>
              <button className="project-action-button history-action" onClick={redo} disabled={future.length === 0}>{text.redo}</button>
            </div>
            <div className="topbar-actions export-actions">
              <div className="print-export-menu">
                <button
                  className="export-action-button primary-action print-export-button"
                  title={`${text.exportPatternTitle} PNG`}
                  aria-expanded={showPrintExportPanel}
                  onClick={() => setShowPrintExportPanel((value) => !value)}
                >
                  <ExportIcon />
                  <span>{text.exportPatternFull}</span>
                </button>
                {showPrintExportPanel && (
                  <div className="print-export-popover">
                    <div className="print-export-popover-header">
                      <strong>{text.printExportSettings}</strong>
                      <button
                        className="print-export-close"
                        type="button"
                        aria-label={text.close}
                        title={text.close}
                        onClick={() => setShowPrintExportPanel(false)}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                    <label className="export-text-field">
                      <span>{text.exportFormat}</span>
                      <select
                        className="export-format-select"
                        value={printExportOptions.format ?? 'png'}
                        onChange={(event) => setPrintExportOptions((current) => ({ ...current, format: event.target.value as PrintExportOptions['format'] }))}
                      >
                        <option value="png">PNG</option>
                        <option value="pdf">PDF（分页打印）</option><option value="svg">SVG（矢量图纸）</option><option value="preview">PNG（无网格预览）</option>
                      </select>
                    </label>
                    <label className="export-text-field">
                      <span>{text.exportBounds}</span>
                      <select
                        className="export-format-select"
                        value={printExportOptions.exportBounds ?? 'pattern'}
                        onChange={(event) => setPrintExportOptions((current) => ({ ...current, exportBounds: event.target.value as 'pattern' | 'canvas' }))}
                      >
                        <option value="pattern">{text.exportPatternBounds}</option>
                        <option value="canvas">{text.exportCanvasBounds}</option>
                      </select>
                    </label>
                    <label className="export-text-field">
                      <span>{text.projectNickname}</span>
                      <input
                        value={printExportOptions.projectName ?? ''}
                        placeholder={defaultPrintNickname}
                        onChange={(event) => setPrintExportOptions((current) => ({ ...current, projectName: event.target.value }))}
                      />
                    </label>
                    <label className="export-text-field">
                      <span>{text.authorNickname}</span>
                      <input
                        value={printExportOptions.authorName ?? ''}
                        placeholder={text.optional}
                        onChange={(event) => setPrintExportOptions((current) => ({ ...current, authorName: event.target.value }))}
                      />
                    </label>
                    <label className="switch-row">
                      <span>{text.showColorCodes}</span>
                      <input
                        type="checkbox"
                        checked={printExportOptions.showColorCodes}
                        onChange={(event) => setPrintExportOptions((current) => ({ ...current, showColorCodes: event.target.checked }))}
                      />
                    </label>
                    <label className="switch-row">
                      <span>{text.showGuideLines}</span>
                      <input
                        type="checkbox"
                        checked={printExportOptions.showGuideLines}
                        onChange={(event) => setPrintExportOptions((current) => ({ ...current, showGuideLines: event.target.checked }))}
                      />
                    </label>
                    <label className="export-text-field"><span>纸张</span><select aria-label="Print paper" value={printExportOptions.paperSize ?? 'a4'} onChange={e => setPrintExportOptions(current => ({ ...current, paperSize: e.target.value as 'a4' | 'letter' }))}><option value="a4">A4</option><option value="letter">Letter</option></select></label>
                    <label className="export-text-field"><span>格间距（毫米）</span><input aria-label="Bead pitch mm" type="number" min={2} max={10} step={.1} value={printExportOptions.pitchMm ?? 5} onChange={e => setPrintExportOptions(current => ({ ...current, pitchMm: Number(e.target.value) }))} /></label>
                    <label className="switch-row"><span>水平镜像</span><input aria-label="Mirror export" type="checkbox" checked={printExportOptions.mirror ?? false} onChange={e => setPrintExportOptions(current => ({ ...current, mirror: e.target.checked }))} /></label>
                    <label className="export-text-field"><span>分页重叠格数</span><select aria-label="Page overlap" value={printExportOptions.overlapCells ?? 1} onChange={e => setPrintExportOptions(current => ({ ...current, overlapCells: Number(e.target.value) }))}>{[0,1,2].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
                    <p className="beadify-hint">请按100%打印，核对50毫米校准尺和实际拼豆板间距。</p>
                    <button className="export-submit-button" onClick={() => void exportPrintPattern()}>
                      {text.exportNow} {(printExportOptions.format ?? 'png').toUpperCase()}
                    </button>
                  </div>
                )}
              </div>
              <button className="export-action-button" onClick={exportVisibleBom}>{language === 'zh' ? '可见图纸 BOM' : 'Visible pattern BOM'}</button>
              <button className="export-action-button" onClick={() => downloadUsageJson(project)}>BOM JSON</button>
              <button className="export-action-button" title={text.exportUsageTitle} onClick={exportUsageList}>{text.exportUsageFull}</button>
              <button className="export-action-button" title={text.exportRecordTitle} onClick={exportEditRecord}>{text.exportRecordFull}</button>
              <button className="export-action-button" title={text.importRecordTitle} onClick={() => jsonInputRef.current?.click()}>{text.importRecordFull}</button>
            </div>
          </div>
        </div>

        <div className="topbar-right">
          <a
            className="github-link"
            href="https://github.com/ItsLucas/beadify-turbo"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            title="GitHub"
          >
            <GitHubIcon />
            <span>GitHub</span>
          </a>
          <div className="language-toggle" aria-label={text.language}>
            <button className={language === 'zh' ? 'active' : ''} onClick={() => setLanguage('zh')}>中</button>
            <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>EN</button>
          </div>
        </div>
      </header>

      <aside className="left-panel">
        <section className="left-card preview-card">
          <div className="left-card-header">
            <div>
              <strong>{text.preview3d}</strong>
              <span>{text.liveBoard}</span>
            </div>
            <small>{totalBeads} {language === 'zh' ? '颗' : 'beads'}</small>
          </div>
          <ThreePreview
            project={displayProject}
            title={text.preview3d}
            emptyLabel={text.previewEmpty}
            closeLabel={text.close}
            expandLabel={text.expandPreview}
          />
        </section>

        <section className="left-card image-card" data-testid="image-generation">
          <div className="left-card-header">
            <div>
              <strong className="field-label-with-help">
                {text.imageToPattern}
                <span className="help-dot image-help-dot" {...imageHelpProps(text.autoGenerateHint)}>?</span>
              </strong>
            </div>
            <small>{pendingFile ? text.ready : text.noImage}</small>
          </div>

          <button className={pendingImageUrl ? `upload-zone has-image${isGenerating ? ' is-generating' : ''}` : `upload-zone${isGenerating ? ' is-generating' : ''}`} onClick={() => fileInputRef.current?.click()}>
            {pendingImageUrl && <img src={pendingImageUrl} alt="" />}
            <span className="upload-zone-text">
              <strong>{isGenerating ? text.preparingPattern : pendingFile ? pendingFile.name : text.uploadImage}</strong>
              <span>{isGenerating ? pendingFile?.name : pendingFile ? 'PNG / JPG / WebP' : 'PNG, JPG, WebP'}</span>
            </span>
          </button>

          <p className="beadify-hint">{language === 'zh' ? '请使用你有权使用的图片；转换图纸不授予原作品的商业使用许可。' : 'Use images you have the right to use; conversion does not grant commercial rights to the source artwork.'} <a href="https://github.com/ItsLucas/beadify-turbo/blob/main/USAGE_RIGHTS.md" target="_blank" rel="noreferrer">{language === 'zh' ? '素材说明' : 'Usage rights'}</a></p>

          <label className="stacked-field">
            <span>{language === 'zh' ? '生成算法' : 'Algorithm'}</span>
            <select aria-label="Generation algorithm" value={generationMethod} onChange={(event) => { invalidateGeneration(); setGenerationMethod(event.target.value as typeof generationMethod); if (event.target.value === 'original') { setMaxColors(Math.max(2, maxColors)); if (coreStyle === 'pixel-input') setCoreStyle('clean'); } }}>
              <option value="optimized">Turbo · 结构优化</option>
              <option value="dominant">Turbo · 主导色采样</option>
              <option value="area">Turbo · {language === 'zh' ? '面积采样' : 'Area'}</option>
              <option value="nearest">Turbo · {language === 'zh' ? '最近邻' : 'Nearest'}</option>
              <option value="original">{language === 'zh' ? '原版算法' : 'Original algorithm'}</option>
            </select>
          </label>
          {sourceImage && <SubjectEditor image={sourceImage} value={preprocessing} onChange={value => { invalidateGeneration(); setPreprocessing(value); }} disabled={isGenerating} />}
          <p className="beadify-hint" data-testid="lite-profile">图片和图纸在当前设备处理，支持手工标注与编辑。</p>
          {sourceImage && <SourceFeatureEditor image={sourceImage} palette={generationPalette()} value={sourceFeatures} selectedColorId={projectColor(project, selectedColorId)?.primaryCode ?? selectedColorId}
            onChange={value => { invalidateGeneration(); setSourceFeatures(value); setGenerationMethod('optimized'); }} disabled={isGenerating} />}
          {!sourceImage && project.beadify?.generationSettings?.sourceName && <p className="beadify-hint">项目可直接编辑、导出和局部重算。重新选择原图可调整主体并再次生成。</p>}
          <TextAnalysisEditor image={sourceImage} value={project.beadify?.textAnalysis} disabled={isGenerating} onChange={changeTextAnalysis} onGenerate={() => void compareTextCandidates()} />
          <TextRetypeEditor analysis={project.beadify?.textAnalysis} palette={generationPalette()} saved={project.beadify?.textRetype}
            disabled={isGenerating || !sourceImage || !project.beadify?.textAnalysis || !matchingText(project.beadify.textAnalysis, sourceImage)} onGenerate={layout => void compareTextCandidates(layout)} />
          <OptimizationEditor value={optimizationOptions} crossBin={crossBinStrokes} disabled={generationMethod !== 'optimized' || isGenerating}
            onChange={value => { invalidateGeneration(); setOptimizationOptions(value); }} onCrossBin={value => { invalidateGeneration(); setCrossBinStrokes(value); }} />
          <label className="stacked-field"><span>图纸风格</span><select aria-label="Pattern style" disabled={generationMethod === 'area' || generationMethod === 'nearest'} value={coreStyle} onChange={e => { invalidateGeneration(); setCoreStyle(e.target.value as typeof coreStyle); }}>
            <option value="clean">简洁色块</option><option value="accurate">保留色阶</option><option value="pixel-art">像素画</option><option value="pixel-input" disabled={generationMethod === 'original'}>原图已是像素画</option>
          </select></label>
          <details className="beadify-advanced"><summary>色卡与重算选项</summary>
            <label>区域采样策略<select aria-label="Sampling strategy" disabled={generationMethod === 'original' || generationMethod === 'area' || generationMethod === 'nearest'} value={samplingStrategy ?? ''} onChange={event => { invalidateGeneration(); setSamplingStrategy(event.target.value as typeof samplingStrategy); }}>
              <option value="">自动（按图纸风格）</option><option value="modes">多模式保留</option><option value="dominant">主导颜色</option><option value="mean">面积均值</option><option value="weighted-area">边缘加权面积</option>
            </select></label>
            <label><span>参考原图边缘细节</span><input aria-label="Source edge evidence" type="checkbox" disabled={generationMethod === 'original' || generationMethod === 'area' || generationMethod === 'nearest'} checked={useSourceEdges} onChange={event => { invalidateGeneration(); setUseSourceEdges(event.target.checked); }} /></label>
            <label><span>轻量去纹理（像素原图模式自动跳过）</span><input aria-label="Texture smoothing" type="checkbox" checked={preprocessing.smoothing ?? false} onChange={e => { invalidateGeneration(); setPreprocessing(current => ({ ...current, smoothing: e.target.checked })); }} /></label>
            <label>仅使用这些色号（留空为全部）<input aria-label="Allowed colors" type="text" value={allowedInput} placeholder="A1, A8, H2, H7" onChange={e => { invalidateGeneration(); setAllowedInput(e.target.value); }} /></label>
            <label>成品必须包含（结构优化）<input aria-label="Required colors" type="text" disabled={generationMethod !== 'optimized'} value={requiredInput} placeholder="H2, H7" onChange={e => { invalidateGeneration(); setRequiredInput(e.target.value); }} /></label>
            <label><span>近似左右对称（结构优化，默认关闭）</span><input aria-label="Symmetry" type="checkbox" disabled={generationMethod !== 'optimized'} checked={useSymmetry} onChange={e => { invalidateGeneration(); setUseSymmetry(e.target.checked); }} /></label>
          </details>
          <label className="stacked-field"><span>采样网格位置</span><select aria-label="采样网格位置" disabled={generationMethod === 'original' || isGenerating} value={samplingPhase.join(',')} onChange={event => { invalidateGeneration(); setSamplingPhase(event.target.value.split(',').map(Number) as [number, number]); }}>
            {SAMPLING_PHASES.map(phase => <option key={phase.label} value={phase.value.join(',')}>{phase.label}{phase.label === '居中' ? '' : ' 0.35 格'}</option>)}
            {!SAMPLING_PHASES.some(phase => phase.value.every((value, index) => value === samplingPhase[index])) && <option value={samplingPhase.join(',')}>已保存位置（{samplingPhase.join(', ')}）</option>}
          </select></label>
          <div className="beadify-actions">
            <button onClick={() => void generateFromImage()} disabled={!sourceImage || isGenerating}>{language === 'zh' ? '生成预览' : 'Generate preview'}</button>
            <button onClick={() => void compareSamplingPhases()} disabled={!sourceImage || generationMethod === 'original' || isGenerating}>比较网格位置</button>
            {isGenerating && <button onClick={invalidateGeneration}>{language === 'zh' ? '取消生成' : 'Cancel generation'}</button>}
          </div>
          {phaseCandidates.length > 0 && <div className="beadify-phase-candidates" role="group" aria-label="网格位置候选">
            {phaseCandidates.map((preview, index) => <button type="button" key={index} aria-label={`选择${SAMPLING_PHASES[index].label}网格`} aria-pressed={candidate === preview} onClick={() => { if (generationSession.current.isCurrent(preview.ticket)) setCandidate(preview); }}>
              <CandidatePreview result={preview.result} palette={preview.pattern?.paletteSnapshot ?? generationPalette()} /><span>{SAMPLING_PHASES[index].label}</span>
            </button>)}
          </div>}

          {textCandidates.length > 0 && <div className="beadify-phase-candidates" role="group" aria-label="文字增强候选比较">
            {textCandidates.map(preview => <button key={preview.label} type="button" aria-label={preview.label} aria-pressed={candidate === preview} onClick={() => { if (generationSession.current.isCurrent(preview.ticket)) setCandidate(preview); }}>
              <CandidatePreview result={preview.result} palette={preview.pattern!.paletteSnapshot} /><span>{preview.label}</span>
            </button>)}
          </div>}
          {candidate && <div className="beadify-candidate" data-testid="generation-candidate">
            <CandidatePreview result={candidate.result} palette={candidate.pattern?.paletteSnapshot ?? generationPalette()} />
            <p>{candidate.mode === 'roi' ? '局部重算 · ' : ''}{candidate.result.width} × {candidate.result.height} · {candidate.result.colorsUsed} {language === 'zh' ? '色' : 'colors'} · {candidate.result.totalBeads} {language === 'zh' ? '颗' : 'beads'}</p>
            {candidate.retypeInfo && <p className="beadify-hint">重新排字 · 自动字号 {candidate.retypeInfo.fontSize.toFixed(1)} 格 · 修改 {candidate.retypeInfo.changedCells} 格。{candidate.textRetype?.backgroundMode === 'blend-color' ? '底色向周围背景渐变过渡。' : candidate.pattern?.diagnostics.warnings.some(w => w.includes('没有明确笔画')) ? '当前底图由周围背景推算，请检查纹理。' : '原笔画位置已参考周围背景修复。'}</p>}
            {candidate.textResult && <details className="beadify-risk"><summary>文字增强诊断 · 修改 {candidate.textResult.changedCells.length} 格</summary>
              <p>无法在当前网格表达或无法确认的区域会保留原样。</p>
              <ul>{candidate.textResult.extraction?.map(d => <li key={d.regionId}>{d.regionId}：{d.status === 'SOURCE_LAYERS_EXTRACTED' ? `已提取原图笔画（${d.inkPixels} 像素）` : d.status === 'EXPLICIT_SOURCE_EVIDENCE_RETAINED' ? '使用手动笔画/背景标注' : `未自动增强（${d.status}）`}</li>)}</ul>
              <ul>{candidate.textResult.health.map(d => <li key={d.regionId}>{d.regionId}：缺失 {d.before.missing} → {d.after.missing}；断裂 {d.before.fragments} → {d.after.fragments}；粘连 {d.before.bridges} → {d.after.bridges}；空洞丢失 {d.before.lostHoles} → {d.after.lostHoles}</li>)}</ul>
            </details>}
            {candidate.pattern && <p className="beadify-risk">独立主体 {candidate.pattern.diagnostics.physicalComponents} · 单颗颜色 {candidate.pattern.diagnostics.monochromeSingletons}。独立主体需分别熨烫；单颗高光可能是必要细节。</p>}
            {candidate.pattern?.diagnostics.warnings.some(w => w.includes('soft feature')) && <p className="beadify-risk">部分细节强化未能保留，请增加色数或手工修正。</p>}
            {candidate.pattern?.diagnostics.warnings.some(warning => /feature|mask|特征/i.test(warning)) && <details className="beadify-risk"><summary>查看细节诊断</summary><ul>{candidate.pattern.diagnostics.warnings.filter(warning => /feature|mask|特征/i.test(warning)).map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
            <div className="beadify-actions">
              <button onClick={acceptCandidate}>{language === 'zh' ? '接受为新图层' : 'Accept as new layer'}</button>
              <button onClick={invalidateGeneration}>{language === 'zh' ? '拒绝候选' : 'Reject preview'}</button>
            </div>
          </div>}

          <div className="image-field-grid">
            <label className="image-number-field">
              <span className="field-label-with-help">
                {text.width}
                <span className="help-dot image-help-dot" {...imageHelpProps(text.heightFromRatio)}>?</span>
              </span>
              <input aria-label="Output width" type="number" min={8} max={180} value={convertWidth} onChange={(event) => { invalidateGeneration(); setConvertWidth(Number(event.target.value)); }} />
            </label>
            <label className="image-number-field"><span>高度</span><input aria-label="Output height" type="number" min={1} max={256} value={convertHeight} onChange={e => { invalidateGeneration(); setConvertHeight(Number(e.target.value)); }} /></label>
            <div className="image-color-limit">
              <label className="image-range-field">
                <span>
                  <span className="field-label-with-help">
                    {text.colors}
                    <span className="help-dot image-help-dot" {...imageHelpProps(text.colorsHint)}>?</span>
                  </span>
                  <strong>{maxColors} / {activePalette.length}</strong>
                </span>
                <input aria-label="Color limit" type="range" min={generationMethod === 'original' ? 2 : 1} max={activePalette.length} step={1} value={maxColors} onChange={(event) => { invalidateGeneration(); setMaxColors(Number(event.target.value)); }} />
              </label>
              <div className="color-limit-controls">
                <input aria-label="Color limit value" type="number" min={generationMethod === 'original' ? 2 : 1} max={activePalette.length} step={1} value={maxColors} onChange={event => { invalidateGeneration(); setMaxColors(clampInteger(Number(event.target.value), generationMethod === 'original' ? 2 : 1, activePalette.length)); }} />
                <button type="button" onClick={() => { invalidateGeneration(); setAllowedInput(''); setMaxColors(activePalette.length); }}>
                  {language === 'zh' ? `使用全部${activePalette.length}色` : `Use all ${activePalette.length} colors`}
                </button>
              </div>
              <p className="beadify-hint">{language === 'zh' ? `当前色卡共 ${activePalette.length} 色，实际用色由图片决定。` : `${activePalette.length} palette colors available; the image determines which are used.`}</p>
            </div>
          </div>
          <label className="stacked-field"><span>常用图纸尺寸</span><select aria-label="Output preset" value={convertWidth === convertHeight ? String(convertWidth) : ''} onChange={e => { invalidateGeneration(); setConvertWidth(Number(e.target.value)); setConvertHeight(Number(e.target.value)); }}>
            <option value="">自定义</option>{[29,40,50,58].map(size => <option key={size} value={size}>{size} × {size}</option>)}
          </select></label>
          <p className="beadify-hint">透明格不计入用量。色卡RGB为近似值，颜色数越少，细节越容易合并。</p>
        </section>

        <section className="left-card"><ConstraintEditor project={project} palette={completeProjectPalette()} selectedColorId={selectedColorId} onChange={updateConstraints} onRecalculate={(indices, source) => void recalculateRegion(indices, source)} disabled={isGenerating} />
          <p className="beadify-risk">{currentDiagnostics.physicalComponents} 个独立主体 · {currentDiagnostics.monochromeSingletons} 颗单独颜色 · {currentDiagnostics.narrowConnections} 处细连接提示。高光无需一律清除。</p>
        </section>
        <section className="left-card reference-card">
          <div className="left-card-header">
            <div>
              <strong>{text.referenceImage}</strong>
              <span>{text.referenceHint}</span>
            </div>
            <small>{referenceImageUrl ? text.ready : text.noImage}</small>
          </div>

          <button className={referenceImageUrl ? 'upload-zone reference-upload-zone has-image' : 'upload-zone reference-upload-zone'} onClick={() => referenceInputRef.current?.click()}>
            {referenceImageUrl && <img src={referenceImageUrl} alt="" />}
            <span className="upload-zone-text">
              <strong>{referenceFile ? referenceFile.name : text.uploadReferenceImage}</strong>
              <span>{referenceFile ? 'PNG / JPG / WebP' : 'PNG, JPG, WebP'}</span>
            </span>
          </button>

          <label className="switch-row reference-switch">
            <span>{text.showReferenceImage}</span>
            <input
              type="checkbox"
              checked={referenceVisible}
              disabled={!referenceImageUrl}
              onChange={(event) => setReferenceVisible(event.target.checked)}
            />
          </label>

          <label className="image-range-field reference-opacity-field">
            <span>
              <span>{text.referenceOpacity}</span>
              <strong>{Math.round((1 - referenceOpacity) * 100)}%</strong>
            </span>
            <input
              aria-label="Reference opacity"
              type="range"
              min={0.1}
              max={0.95}
              step={0.05}
              value={1 - referenceOpacity}
              disabled={!referenceImageUrl || !referenceVisible}
              onChange={(event) => setReferenceOpacity(1 - Number(event.target.value))}
            />
          </label>

          <div className="reference-adjust-row">
            <label className="switch-row reference-switch">
              <span>{text.referenceAdjust}</span>
              <input
                type="checkbox"
                checked={referenceAdjusting}
                disabled={!referenceImageUrl || !referenceVisible}
                onChange={(event) => setReferenceAdjusting(event.target.checked)}
              />
            </label>
            <button
              type="button"
              className="reference-reset-button"
              disabled={!referenceImageUrl}
              onClick={resetReferenceTransform}
            >
              {text.resetReferenceTransform}
            </button>
          </div>

          <div className="reference-control-grid">
            <label className="stacked-field reference-placement-field">
              <span>{text.referencePlacement}</span>
              <div className="reference-placement-toggle" aria-label={text.referencePlacement}>
                <button
                  type="button"
                  className={referencePlacement === 'below' ? 'active' : ''}
                  disabled={!referenceImageUrl}
                  aria-pressed={referencePlacement === 'below'}
                  onClick={() => setReferencePlacement('below')}
                >
                  {text.referenceBelow}
                </button>
                <button
                  type="button"
                  className={referencePlacement === 'above' ? 'active' : ''}
                  disabled={!referenceImageUrl}
                  aria-pressed={referencePlacement === 'above'}
                  onClick={() => setReferencePlacement('above')}
                >
                  {text.referenceAbove}
                </button>
              </div>
            </label>
          </div>
        </section>
      </aside>

      <aside className="tool-rail">
        {tools.map((item) => (
          <button
            key={item.id}
            className={tool === item.id ? 'tool-button active' : 'tool-button'}
            aria-label={text.tools[item.id].title}
            aria-pressed={tool === item.id}
            type="button"
            onPointerDown={(event) => {
              if (event.pointerType === 'mouse') return;
              event.preventDefault();
              activateTool(item.id);
            }}
            onClick={() => activateTool(item.id)}
          >
            <ToolIcon tool={item.id} />
            <span>{text.tools[item.id].title}</span>
          </button>
        ))}
        {tool === 'pencil' && showPencilOptions && (
          <div className="tool-options pencil-options" onMouseLeave={() => setShowPencilOptions(false)}>
            <div className="right-click-toggle compact" aria-label={text.rightClick}>
              <span className="field-label-with-help">
                {text.rightClick}
                <span className="help-dot mini" data-tooltip={text.rightClickHint} aria-label={text.rightClickHint} tabIndex={0}>?</span>
              </span>
              <div>
                {(['pan', 'erase'] as RightClickAction[]).map((action) => (
                  <button
                    key={action}
                    className={project.settings.rightClickAction === action ? 'active' : ''}
                    type="button"
                    aria-pressed={project.settings.rightClickAction === action}
                    onClick={() =>
                      updateProject({
                        ...project,
                        settings: { ...project.settings, rightClickAction: action },
                      })
                    }
                  >
                    {action === 'pan' ? text.pan : text.erase}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {tool === 'eraser' && showEraserOptions && (
          <div className="tool-options eraser-options" onMouseLeave={() => setShowEraserOptions(false)}>
            <div className="tool-options-header">
              <span>{text.eraserSize}</span>
              <strong>{text.brushCells(eraserSize)}</strong>
            </div>
            <div className="brush-preview" aria-hidden="true">
              {eraserSize > 0 ? (
                <span style={{ width: `${10 + eraserSize * 3}px`, height: `${10 + eraserSize * 3}px` }} />
              ) : (
                <span className="brush-preview-dot" />
              )}
            </div>
            <input
              aria-label={text.eraserSize}
              type="range"
              min={0}
              max={9}
              step={0.5}
              value={eraserSize}
              onChange={(event) => setEraserSize(Number(event.target.value))}
            />
          </div>
        )}
        {tool === 'remove' && showRemoveOptions && (
          <div className="tool-options remove-options" onMouseLeave={() => setShowRemoveOptions(false)}>
            <div className="right-click-toggle compact remove-scope-toggle" aria-label={text.removeScope}>
              <span>{text.removeScope}</span>
              <div>
                {(['same-connected', 'all-same-color', 'connected'] as RemoveMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={removeMode === mode ? 'active' : ''}
                    type="button"
                    aria-pressed={removeMode === mode}
                    onClick={() => setRemoveMode(mode)}
                  >
                    {mode === 'same-connected'
                      ? text.removeSameConnected
                      : mode === 'all-same-color'
                        ? text.removeAllSameColor
                        : text.removeConnected}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {tool === 'move' && showMoveOptions && (
          <div className="tool-options move-options" onMouseLeave={() => setShowMoveOptions(false)}>
            <div className="right-click-toggle compact" aria-label={text.moveScope}>
              <span>{text.moveScope}</span>
              <div>
                {(['layer', 'partial'] as MoveMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={moveMode === mode ? 'active' : ''}
                    type="button"
                    aria-pressed={moveMode === mode}
                    onClick={() => setMoveMode(mode)}
                  >
                    {mode === 'layer' ? text.moveLayer : text.movePartial}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {(tool === 'copy' || tool === 'paste') && showClipboardOptions && (
          <div
            className={`tool-options clipboard-options ${tool === 'copy' ? 'copy-options' : 'paste-options'}`}
            onMouseLeave={() => setShowClipboardOptions(false)}
          >
            {tool === 'copy' && (
              <div className="right-click-toggle compact clipboard-mode-toggle" aria-label={text.copyScope}>
                <span>{text.copyScope}</span>
                <div>
                  {(['connected', 'selection'] as CopyMode[]).map((mode) => (
                    <button
                      key={mode}
                      className={copyMode === mode ? 'active' : ''}
                      type="button"
                      aria-pressed={copyMode === mode}
                      onClick={() => {
                        setCopyMode(mode);
                        setCopySelectionIndices([]);
                      }}
                    >
                      {mode === 'connected' ? text.copyConnected : text.copySelection}
                    </button>
                  ))}
                </div>
                {copyMode === 'selection' && <p className="tool-hint compact-hint">{text.copySelectionHint}</p>}
              </div>
            )}
            <div className="clipboard-tool-header">
              <div>
                <strong>{text.clipboardPreview}</strong>
                {clipboardPattern && (
                  <span>{text.clipboardSize(clipboardPattern.width, clipboardPattern.height, clipboardPattern.cells.filter(Boolean).length)}</span>
                )}
              </div>
              <button
                className="clipboard-reset-button"
                type="button"
                aria-label={text.resetClipboard}
                title={text.resetClipboard}
                disabled={!clipboardPattern && copySelectionIndices.length === 0}
                onClick={resetClipboard}
              >
                <ResetIcon />
              </button>
            </div>
            {clipboardPattern ? (
              <ClipboardPreview pattern={clipboardPattern} />
            ) : (
              <div className="clipboard-empty">{text.clipboardEmpty}</div>
            )}
          </div>
        )}
        {tool === 'mirror' && showMirrorOptions && (
          <div className="tool-options mirror-options" onMouseLeave={() => setShowMirrorOptions(false)}>
            <div className="right-click-toggle compact" aria-label={text.moveScope}>
              <span>{text.moveScope}</span>
              <div>
                {(['layer', 'partial'] as MoveMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={mirrorMode === mode ? 'active' : ''}
                    type="button"
                    aria-pressed={mirrorMode === mode}
                    onClick={() => setMirrorMode(mode)}
                  >
                    {mode === 'layer' ? text.moveLayer : text.movePartial}
                  </button>
                ))}
              </div>
            </div>
            <div className="right-click-toggle compact" aria-label={text.mirrorDirection}>
              <span>{text.mirrorDirection}</span>
              <div>
                {(['horizontal', 'vertical'] as MirrorDirection[]).map((direction) => (
                  <button
                    key={direction}
                    className={mirrorDirection === direction ? 'active' : ''}
                    type="button"
                    aria-pressed={mirrorDirection === direction}
                    onClick={() => setMirrorDirection(direction)}
                  >
                    {direction === 'horizontal' ? text.mirrorHorizontal : text.mirrorVertical}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {tool === 'shape' && showShapeOptions && (
          <div className="tool-options shape-options" onMouseLeave={() => setShowShapeOptions(false)}>
            <div className="right-click-toggle compact" aria-label={text.shapeStyle}>
              <span>{text.shapeStyle}</span>
              <div>
                {(['outline', 'filled'] as ShapeFillMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={shapeFillMode === mode ? 'active' : ''}
                    type="button"
                    aria-pressed={shapeFillMode === mode}
                    disabled={shapeKind === 'line' || shapeKind === 'arrow'}
                    onClick={() => setShapeFillMode(mode)}
                  >
                    {mode === 'outline' ? text.shapeOutline : text.shapeFilled}
                  </button>
                ))}
              </div>
            </div>
            <div className="shape-picker" aria-label={text.shapeType}>
              <span>{text.shapeType}</span>
              <div>
                {(['line', 'rectangle', 'square', 'ellipse', 'circle', 'triangle', 'arrow'] as ShapeKind[]).map((kind) => (
                  <button
                    key={kind}
                    className={shapeKind === kind ? 'active' : ''}
                    type="button"
                    aria-pressed={shapeKind === kind}
                    onClick={() => setShapeKind(kind)}
                  >
                    <ShapeOptionIcon shape={kind} />
                    <span>{shapeLabel[kind]}</span>
                  </button>
                ))}
              </div>
            </div>
            {shapeKind === 'arrow' && (
              <div className="shape-picker arrow-picker" aria-label={text.arrowStyle}>
                <span>{text.arrowStyle}</span>
                <div>
                  {(['single', 'double', 'block'] as ArrowKind[]).map((kind) => (
                    <button
                      key={kind}
                      className={arrowKind === kind ? 'active' : ''}
                      type="button"
                      aria-pressed={arrowKind === kind}
                      onClick={() => setArrowKind(kind)}
                    >
                      <ArrowOptionIcon arrow={kind} />
                      <span>{arrowLabel[kind]}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {tool === 'text' && showTextOptions && (
          <div className="tool-options text-options">
            <label className="text-tool-field">
              <span className="text-field-title">
                {text.textContent}
                <button
                  className="tool-options-close"
                  type="button"
                  aria-label={text.close}
                  title={text.close}
                  onClick={() => setShowTextOptions(false)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 7l10 10" />
                    <path d="M17 7L7 17" />
                  </svg>
                </button>
              </span>
              <input
                type="text"
                maxLength={32}
                value={textToolValue}
                placeholder={text.textPlaceholder}
                onChange={(event) => setTextToolValue(event.target.value)}
              />
            </label>
            <div className="right-click-toggle compact" aria-label={text.textDirection}>
              <span>{text.textDirection}</span>
              <div>
                {(['horizontal', 'vertical'] as TextDirection[]).map((direction) => (
                  <button
                    key={direction}
                    className={textToolDirection === direction ? 'active' : ''}
                    type="button"
                    aria-pressed={textToolDirection === direction}
                    onClick={() => setTextToolDirection(direction)}
                  >
                    {direction === 'horizontal' ? text.textHorizontal : text.textVertical}
                  </button>
                ))}
              </div>
            </div>
            <div className="tool-options-header">
              <span>{text.textSize}</span>
              <label className="tool-number-field" aria-label={text.textSize}>
                <input
                  type="number"
                  min={5}
                  max={72}
                  step={1}
                  value={textToolSize}
                  onChange={(event) => setTextToolSize(Math.min(72, Math.max(5, Number(event.target.value) || 5)))}
                />
                <span>{language === 'zh' ? '格' : 'cells'}</span>
              </label>
            </div>
            <input
              aria-label={text.textSize}
              type="range"
              min={5}
              max={72}
              step={1}
              value={textToolSize}
              onChange={(event) => setTextToolSize(Number(event.target.value))}
            />
            <div className="tool-options-header">
              <span>{text.textSpacing}</span>
              <label className="tool-number-field" aria-label={text.textSpacing}>
                <input
                  type="number"
                  min={0}
                  max={24}
                  step={1}
                  value={textToolSpacing}
                  onChange={(event) => setTextToolSpacing(Math.min(24, Math.max(0, Number(event.target.value) || 0)))}
                />
                <span>{language === 'zh' ? '格' : 'cells'}</span>
              </label>
            </div>
            <input
              aria-label={text.textSpacing}
              type="range"
              min={0}
              max={24}
              step={1}
              value={textToolSpacing}
              onChange={(event) => setTextToolSpacing(Number(event.target.value))}
            />
          </div>
        )}
        {tool === 'pan' && showPanOptions && (
          <div className="tool-options pan-options" onMouseLeave={() => setShowPanOptions(false)}>
            <div className="tool-options-header">
              <strong>{text.tools.pan.title}</strong>
            </div>
            <p className="tool-hint">{text.panToolHint}</p>
          </div>
        )}
      </aside>

      <WorkspaceCanvas
        project={displayProject}
        selectedColorId={selectedColorId}
        highlightedColorId={highlightedColorId}
        highlightedCellIndices={isolatedCellIndices}
        formatColorCode={displayCodeById}
        tool={tool}
        eraserSize={eraserSize}
        moveMode={moveMode}
        removeMode={removeMode}
        mirrorMode={mirrorMode}
        mirrorDirection={mirrorDirection}
        shapeKind={shapeKind}
        shapeFillMode={shapeFillMode}
        arrowKind={arrowKind}
        textToolValue={textToolValue}
        textToolDirection={textToolDirection}
        textToolSize={textToolSize}
        textToolSpacing={textToolSpacing}
        onTextToolSizeChange={setTextToolSize}
        referenceImageUrl={referenceImageUrl}
        referenceImageVisible={referenceVisible && !isGenerating}
        referenceImageOpacity={referenceOpacity}
        referenceImageScale={referenceScale}
        referenceImageOffset={referenceOffset}
        referenceImageAdjusting={referenceAdjusting && referenceVisible && !isGenerating}
        referenceImagePlacement={referencePlacement}
        referenceAdjustHint={text.referenceAdjustHint}
        onReferenceOffsetChange={setReferenceOffset}
        onReferenceScaleChange={setReferenceScale}
        onCommitStart={() => {
          setShowPencilOptions(false);
          setShowEraserOptions(false);
          setShowRemoveOptions(false);
          setShowMoveOptions(false);
          setShowMirrorOptions(false);
          setShowShapeOptions(false);
          setShowTextOptions(tool === 'text');
          setShowClipboardOptions(false);
          setShowPanOptions(false);
          commitHistory();
        }}
        onCellsChange={updateCells}
        onReplaceColor={replaceColor}
        clipboardPattern={clipboardPattern}
        copyMode={copyMode}
        copySelectionIndices={copySelectionIndices}
        onCopyPattern={(pattern, switchToPaste = true) => {
          const beads = pattern.cells.filter(Boolean).length;
          setClipboardPattern(pattern);
          if (switchToPaste) setTool('paste');
          setShowPencilOptions(false);
          setShowEraserOptions(false);
          setShowRemoveOptions(false);
          setShowMoveOptions(false);
          setShowMirrorOptions(false);
          setShowShapeOptions(false);
          setShowTextOptions(false);
          setShowClipboardOptions(false);
          setShowPanOptions(false);
          setNotice(text.copiedPattern(pattern.width, pattern.height, beads));
        }}
        onCopySelectionChange={(indices, pattern) => {
          setCopySelectionIndices(indices);
          setClipboardPattern(pattern);
          setNotice(pattern ? text.copySelectionUpdated(pattern.cells.filter(Boolean).length) : text.clipboardReset);
        }}
        onPastePattern={() => setNotice(text.pastedPattern)}
        onPickColor={(colorId) => {
          selectColor(colorId);
          setTool('pencil');
          setShowPencilOptions(false);
          setShowEraserOptions(false);
          setShowRemoveOptions(false);
          setShowMoveOptions(false);
          setShowMirrorOptions(false);
          setShowShapeOptions(false);
          setShowTextOptions(false);
          setShowClipboardOptions(false);
          setShowPanOptions(false);
          setNotice(language === 'zh' ? '已从画布拾取颜色。' : 'Color picked from canvas.');
        }}
        onHover={setHoverCell}
        fitLabel={text.fit}
        canEdit={!activeLayer.locked}
        lockedHint={text.lockedCanvasHint}
      />

      <aside className="right-panel">
        <div className="right-tabs" role="tablist" aria-label="Right panel">
          <button
            className={rightTab === 'palette' ? 'active' : ''}
            role="tab"
            aria-selected={rightTab === 'palette'}
            onClick={() => setRightTab('palette')}
          >
            {text.palette}
          </button>
          <button
            className={rightTab === 'layers' ? 'active' : ''}
            role="tab"
            aria-selected={rightTab === 'layers'}
            onClick={() => setRightTab('layers')}
          >
            {text.layers}
          </button>
          <button
            className={rightTab === 'usage' ? 'active' : ''}
            role="tab"
            aria-selected={rightTab === 'usage'}
            onClick={() => setRightTab('usage')}
          >
            {text.usage}
          </button>
          <button
            className={rightTab === 'adjustments' ? 'active' : ''}
            role="tab"
            aria-selected={rightTab === 'adjustments'}
            onClick={() => setRightTab('adjustments')}
          >
            {text.adjustments}
          </button>
        </div>

        <section className="panel-section status-section">
          <div>
            <strong>{notice}</strong>
            <span>
              {text.panelStatus(project.width, project.height, usage.length, totalBeads, boardCount)}
            </span>
          </div>
          <span className="status-pill">{text.tools[tool].title}</span>
        </section>

          {generationProgress && (isGenerating || candidate) && <div className="generation-progress" data-testid="generation-progress" aria-live="polite">
            <p><strong>{generationProgress.label}</strong><span>{Math.floor(generationProgress.value)}%</span></p>
            <progress aria-label="图案生成进度" max={100} value={generationProgress.value} />
            {generationProgress.evaluations !== undefined && <small>已评估 {generationProgress.evaluations.toLocaleString()} / {generationProgress.maxEvaluations?.toLocaleString()} 次；达到收敛可提前完成。</small>}
            {isGenerating && <button onClick={invalidateGeneration}>取消当前生成</button>}
          </div>}

        {rightTab === 'palette' && (
          <section className="panel-section panel-tab-body palette-section">
            <h2>{text.palette}</h2>
            <div className="palette-selected-card">
              <span style={{ backgroundColor: selectedColor?.hex }} />
              <div className="palette-selected-main">
                <strong>{selectedColor ? displayCode(selectedColor) : ''}</strong>
                <small>{selectedColor ? displayName(selectedColor) : ''}</small>
              </div>
              <div className="palette-selected-hex">
                <small>{selectedColor?.hex}</small>
              </div>
            </div>
            <div className="recent-colors-field">
              <span>{text.recentColors}</span>
              <div className="recent-color-row">
                {recentColors.map((color) => (
                  <button
                    key={color.id}
                    type="button"
                    className={selectedColorId === color.id ? 'active' : ''}
                    title={`${displayCode(color)} ${displayName(color)}`}
                    aria-label={`${text.recentColors} ${displayCode(color)}`}
                    onClick={() => selectColor(color.id, { updateRecent: false })}
                  >
                    <span style={{ backgroundColor: color.hex }} />
                    <small>{displayCode(color)}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="readonly-brand-field">
              {text.brandCodes}
              <select aria-label="Palette mode" value={paletteMode} onChange={(event) => { invalidateGeneration(); setPaletteMode(event.target.value as PaletteMode); }}>
                <option value="basic">{text.mardBasic}</option>
                <option value="complete">{text.mardComplete}</option>
              </select>
            </div>
            <div className="palette-filter" aria-label="Palette groups">
              {paletteGroups.map((group) => (
                <button
                  key={group.id}
                  className={paletteGroup === group.id ? 'active' : ''}
                  onClick={() => setPaletteGroup(group.id)}
                >
                  {group.label}
                </button>
              ))}
            </div>
            <div className="palette-grid">
              {visiblePalette.map((color) => (
                <button
                  key={color.id}
                  className={selectedColorId === color.id ? 'swatch active' : 'swatch'}
                  title={`${displayCode(color)} ${displayName(color)}`}
                  onClick={() => {
                    selectColor(color.id);
                  }}
                >
                  <span style={{ backgroundColor: color.hex }} />
                  <small>{displayCode(color)}</small>
                </button>
              ))}
            </div>
          </section>
        )}

        {rightTab === 'layers' && (
          <section className="panel-section panel-tab-body layers-section">
            <div className="layers-header">
              <h2>{text.layers}</h2>
              <button onClick={addLayer}>{text.addLayer}</button>
            </div>
            <button
              className={project.settings.showActiveLayerOnly ? 'layer-solo-toggle active' : 'layer-solo-toggle'}
              type="button"
              aria-pressed={project.settings.showActiveLayerOnly}
              onClick={toggleActiveLayerOnly}
            >
              <EyeIcon visible={project.settings.showActiveLayerOnly} />
              <span>{text.showActiveLayerOnly}</span>
            </button>
            <div
              className="layer-list"
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTarget(null);
              }}
            >
              {[...layers].reverse().map((layer) => {
                const layerIndex = layers.findIndex((item) => item.id === layer.id);
                const isActive = layer.id === activeLayer.id;
                const beadCount = layer.cells.filter(Boolean).length;
                const displayName = layerDisplayName(layer, layerIndex);
                const rowClassName = [
                  'layer-row',
                  isActive ? 'active' : '',
                  draggingLayerId === layer.id ? 'dragging' : '',
                  dragTarget?.id === layer.id && draggingLayerId !== layer.id ? `drag-over-${dragTarget.edge}` : '',
                ].filter(Boolean).join(' ');
                return (
                  <div
                    key={layer.id}
                    className={rowClassName}
                    onDragOver={(event) => {
                      if (!draggingLayerId || draggingLayerId === layer.id) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const nextTarget = dragTargetFromEvent(event, layer.id);
                      setDragTarget((current) =>
                        current?.id === nextTarget.id && current.edge === nextTarget.edge ? current : nextTarget,
                      );
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const sourceId = event.dataTransfer.getData('text/plain') || draggingLayerId;
                      const nextTarget = dragTargetFromEvent(event, layer.id);
                      setDraggingLayerId(null);
                      setDragTarget(null);
                      if (sourceId) moveLayer(sourceId, nextTarget);
                    }}
                  >
                    <button
                      className="layer-drag-handle"
                      draggable
                      title={text.reorderLayer}
                      aria-label={text.reorderLayer}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', layer.id);
                        const dragImage = document.createElement('canvas');
                        dragImage.width = 1;
                        dragImage.height = 1;
                        event.dataTransfer.setDragImage(dragImage, 0, 0);
                        setDraggingLayerId(layer.id);
                      }}
                      onDragEnd={() => {
                        setDraggingLayerId(null);
                        setDragTarget(null);
                      }}
                    >
                      <DragHandleIcon />
                    </button>
                    <button
                      className={layer.visible ? 'mini-icon-toggle visibility-toggle active' : 'mini-icon-toggle visibility-toggle'}
                      title={layer.visible ? text.eye : text.hiddenLayer}
                      aria-label={layer.visible ? text.eye : text.hiddenLayer}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateLayer(layer.id, { visible: !layer.visible });
                      }}
                    >
                      <EyeIcon visible={layer.visible} />
                    </button>
                    {editingLayerId === layer.id ? (
                      <form
                        className="layer-main layer-name-editor"
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveEditingLayer(layer, layerIndex);
                        }}
                      >
                        <input
                          value={editingLayerName}
                          aria-label={text.renameLayer}
                          autoFocus
                          onChange={(event) => setEditingLayerName(event.target.value)}
                          onBlur={() => saveEditingLayer(layer, layerIndex)}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setEditingLayerId(null);
                            }
                          }}
                        />
                        <span className="layer-meta">{layerMetaText(isActive, layer.visible, layer.locked, beadCount)}</span>
                      </form>
                    ) : (
                      <div className="layer-main layer-main-static" onClick={() => selectLayer(layer.id)}>
                        <div className="layer-title-row">
                          <strong>
                            <span>{displayName}</span>
                            <button
                              className="layer-rename-button"
                              type="button"
                              title={text.renameLayer}
                              aria-label={text.renameLayer}
                              onClick={(event) => {
                                event.stopPropagation();
                                startEditingLayer(layer, layerIndex);
                              }}
                            >
                              <PencilIcon />
                            </button>
                          </strong>
                        </div>
                        <span className="layer-meta">
                          {layerMetaText(isActive, layer.visible, layer.locked, beadCount)}
                        </span>
                      </div>
                    )}
                    <div className="layer-actions">
                      <button
                        className={layer.locked ? 'mini-icon-toggle active' : 'mini-icon-toggle'}
                        aria-label={layer.locked ? text.unlock : text.lock}
                        title={layer.locked ? text.unlockHint : text.lockHint}
                        onClick={() => updateLayer(layer.id, { locked: !layer.locked })}
                      >
                        <LockIcon locked={layer.locked} />
                      </button>
                      <button
                        className="mini-icon-toggle"
                        aria-label={text.duplicateLayer}
                        title={text.duplicateLayer}
                        onClick={() => duplicateLayer(layer.id)}
                      >
                        <DuplicateIcon />
                      </button>
                      <button
                        className="mini-icon-toggle danger"
                        disabled={layers.length <= 1}
                        aria-label={text.deleteLayer}
                        title={text.deleteLayer}
                        onClick={() => deleteLayer(layer.id)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {rightTab === 'usage' && (
          <section className="panel-section panel-tab-body usage-section">
            <h2>{text.usage}</h2>
            <div className="usage-overview">
              <div>
                <span>{text.totalBeadsLabel}</span>
                <strong>{totalBeads}</strong>
              </div>
              <div>
                <span>{text.colorTypes}</span>
                <strong>{usage.length}</strong>
              </div>
              <div>
                <span>{text.estimatedPacks}</span>
                <strong>{totalPacks}</strong>
              </div>
            </div>
            <label className="usage-pack-setting">
              <span>{text.beadsPerPack}</span>
              <div className="usage-pack-control">
                <div className="usage-pack-stepper">
                  <button
                    type="button"
                    onClick={() => stepBeadsPerPack(-1)}
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    step={500}
                    value={project.settings.beadsPerPack}
                    onChange={(event) => setBeadsPerPack(Number(event.target.value))}
                  />
                  <button
                    type="button"
                    onClick={() => stepBeadsPerPack(1)}
                  >
                    +
                  </button>
                </div>
                <small>{text.perPackUnit}</small>
              </div>
            </label>
            <div className="usage-summary-card">
              <div className="usage-summary-head"><strong>当前可见图纸</strong><span>{layers.filter(layer => layer.visible && layer.opacity > 0).length} 个可见图层</span></div>
              <p className="beadify-hint">重叠位置只统计最上方可见豆子；隐藏图层不计入用量。</p>
              {(usage.length > 32 || isolatedBeads > 0) && (
                <div className="usage-notes">
                  {usage.length > 32 && <span>{text.manyColors}</span>}
                  {isolatedBeads > 0 && (
                    <span className="usage-note-line">
                      <span>{text.isolatedBeads(isolatedBeads)}</span>
                      <button
                        className={showIsolatedBeads ? 'usage-note-eye active' : 'usage-note-eye'}
                        type="button"
                        title={showIsolatedBeads ? text.hideIsolatedBeads : text.showIsolatedBeads}
                        aria-label={showIsolatedBeads ? text.hideIsolatedBeads : text.showIsolatedBeads}
                        aria-pressed={showIsolatedBeads}
                        onClick={() => setShowIsolatedBeads((current) => !current)}
                      >
                        <EyeIcon visible={showIsolatedBeads} />
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="usage-list">
              {usage.map((row) => (
                <button
                  key={row.color.id}
                  onMouseEnter={() => setHighlightedColorId(row.color.id)}
                  onMouseLeave={() => setHighlightedColorId(null)}
                >
                  <span className="usage-chip" style={{ backgroundColor: row.color.hex }} />
                  <span className="usage-color-info">
                    <strong>{displayCode(row.color)}</strong>
                    <small>{displayName(row.color)}</small>
                  </span>
                  <span className="usage-count">
                    <strong>{row.count}</strong>
                    <small>{row.packs} {text.packUnit}</small>
                  </span>
                </button>
              ))}
              {usage.length === 0 && <div className="usage-empty">{text.noUsage}</div>}
            </div>
          </section>
        )}

        {rightTab === 'adjustments' && (
          <section className="panel-section panel-tab-body adjustment-section">
            <div className="adjustment-header">
              <h2>{text.adjustmentTitle}</h2>
              <span>{layerDisplayName(activeLayer, layers.findIndex((item) => item.id === activeLayer.id))}</span>
            </div>
            <div className="adjustment-help">{text.adjustmentHint}</div>
            {([
              ['brightness', text.brightness, -50, 50, '%'],
              ['contrast', text.contrast, -50, 50, '%'],
              ['saturation', text.saturation, -50, 50, '%'],
              ['temperature', text.temperature, -50, 50, '%'],
              ['hue', text.hue, -180, 180, 'deg'],
            ] as const).map(([key, label, min, max, unit]) => (
              <label className="adjustment-range" key={key}>
                <span>
                  <span>{label}</span>
                  <strong>{adjustments[key]}{unit}</strong>
                </span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={key === 'hue' ? 5 : 1}
                  value={adjustments[key]}
                  onChange={(event) => updateAdjustment(key, Number(event.target.value))}
                />
              </label>
            ))}
            <div className="adjustment-actions">
              <button type="button" onClick={resetAdjustments} disabled={!hasAdjustments(adjustments)}>
                {text.resetAdjustments}
              </button>
            </div>
            <div className="adjustment-effect-card">
              <strong>{text.effects}</strong>
              <div className="adjustment-effect-grid">
                <button type="button" onClick={() => applyLayerEffect('invert', text.invertEffect)} disabled={activeLayer.locked}>
                  {text.invertEffect}
                </button>
                <button type="button" onClick={() => applyLayerEffect('grayscale', text.grayscaleEffect)} disabled={activeLayer.locked}>
                  {text.grayscaleEffect}
                </button>
                <button type="button" onClick={() => applyLayerEffect('blackWhite', text.blackWhiteEffect)} disabled={activeLayer.locked}>
                  {text.blackWhiteEffect}
                </button>
              </div>
            </div>
            <div className="adjustment-tool-card">
              <div className="adjustment-tool-heading">
                <strong>{text.colorCleanup}</strong>
                <b>{colorCleanupStrength}</b>
              </div>
              <span>{text.colorCleanupHint}</span>
              <input
                aria-label="Color cleanup strength"
                type="range"
                min={1}
                max={4}
                step={1}
                value={colorCleanupStrength}
                onChange={(event) => setColorCleanupStrength(Number(event.target.value))}
              />
              <button type="button" onClick={applyColorCleanup} disabled={activeLayer.locked}>
                {text.applyColorCleanup}
              </button>
            </div>
            <div className="adjustment-tool-card">
              <div className="adjustment-tool-heading">
                <strong>{text.colorLimit}</strong>
                <b>{layerColorLimit} / {activePalette.length}</b>
              </div>
              <span>{text.colorLimitHint}</span>
              <input
                aria-label="Layer color limit"
                type="range"
                min={2}
                max={activePalette.length}
                step={1}
                value={layerColorLimit}
                onChange={(event) => setLayerColorLimit(Number(event.target.value))}
              />
              <input aria-label="Layer color limit value" type="number" className="color-limit-number" min={2} max={activePalette.length} step={1} value={layerColorLimit} onChange={event => setLayerColorLimit(clampInteger(Number(event.target.value), 2, activePalette.length))} />
              <button type="button" onClick={applyLayerColorLimit} disabled={activeLayer.locked}>
                {text.applyColorLimit}
              </button>
            </div>
          </section>
        )}

        {rightTab === 'palette' && (
          <>
            <section className="panel-section view-section">
              <h2>{text.view}</h2>
            <div className="view-toggle-grid">
              <div className="view-shape-toggle" aria-label={text.beadShape}>
                <span>{text.beadShape}</span>
                <div>
                  <button
                    type="button"
                    className={project.settings.beadDisplayMode === 'bead' ? 'active' : ''}
                    aria-pressed={project.settings.beadDisplayMode === 'bead'}
                    onClick={() => updateProject({ ...project, settings: { ...project.settings, beadDisplayMode: 'bead' } })}
                  >
                    <span className="shape-choice-icon shape-choice-icon-round" aria-hidden="true" />
                    <span>{text.roundBeads}</span>
                  </button>
                  <button
                    type="button"
                    className={project.settings.beadDisplayMode === 'pixel' ? 'active' : ''}
                    aria-pressed={project.settings.beadDisplayMode === 'pixel'}
                    onClick={() => updateProject({ ...project, settings: { ...project.settings, beadDisplayMode: 'pixel' } })}
                  >
                    <span className="shape-choice-icon shape-choice-icon-square" aria-hidden="true" />
                    <span>{text.squareBeads}</span>
                  </button>
                </div>
              </div>
              <div className="view-row">
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={project.settings.showGrid}
                    onChange={(event) =>
                      updateProject({ ...project, settings: { ...project.settings, showGrid: event.target.checked } })
                    }
                  />
                  {text.grid}
                </label>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={project.settings.showCoordinates}
                    onChange={(event) =>
                      updateProject({ ...project, settings: { ...project.settings, showCoordinates: event.target.checked } })
                    }
                  />
                  {text.coordinates}
                </label>
              </div>
              <div className="view-row">
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={project.settings.showColorCodes}
                    onChange={(event) =>
                      updateProject({ ...project, settings: { ...project.settings, showColorCodes: event.target.checked } })
                    }
                  />
                  {text.showColorCodes}
                </label>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={project.settings.showLayerOverlap}
                    onChange={(event) =>
                      updateProject({ ...project, settings: { ...project.settings, showLayerOverlap: event.target.checked } })
                    }
                  />
                  {text.layerOverlap}
                </label>
              </div>
            </div>
            </section>

            <section className="panel-section hover-section">
              <h2>{text.cell}</h2>
              {hoverCell ? (
                <span>
                  R{hoverCell.y + 1} C{hoverCell.x + 1} - {projectColor(project, hoverCell.colorId)?.primaryCode ?? text.empty}
                </span>
              ) : (
                <span>{text.hoverBoard}</span>
              )}
            </section>
          </>
        )}
      </aside>
      {floatingHelp && (
        <div className="floating-help-tooltip" style={{ left: floatingHelp.left, top: floatingHelp.top }}>
          {floatingHelp.text}
        </div>
      )}
    </main>
  );
}

function hasAdjustments(adjustments: AdjustmentSettings): boolean {
  return (
    adjustments.brightness !== 0 ||
    adjustments.contrast !== 0 ||
    adjustments.saturation !== 0 ||
    adjustments.temperature !== 0 ||
    adjustments.hue !== 0
  );
}

function adjustLayerCells(
  cells: Array<string | null>,
  adjustments: AdjustmentSettings,
  activePalette: NonNullable<ReturnType<typeof getColor>>[],
): Array<string | null> {
  if (!hasAdjustments(adjustments)) return cells;
  const cache = new Map<string, string>();
  return cells.map((colorId) => {
    if (!colorId) return null;
    const cached = cache.get(colorId);
    if (cached) return cached;
    const color = getColor(colorId);
    if (!color) return colorId;
    const adjustedRgb = adjustRgb(color.rgb, adjustments);
    const mapped = nearestPaletteColor(adjustedRgb, activePalette);
    cache.set(colorId, mapped.id);
    return mapped.id;
  });
}

function adjustRgb(rgb: [number, number, number], adjustments: AdjustmentSettings): [number, number, number] {
  const contrastValue = adjustments.contrast * 2.55;
  const contrastFactor = (259 * (contrastValue + 255)) / (255 * (259 - contrastValue));
  const warmed: [number, number, number] = [
    clampByte(rgb[0] + adjustments.temperature * 1.35),
    clampByte(rgb[1] + adjustments.temperature * 0.28),
    clampByte(rgb[2] - adjustments.temperature * 1.35),
  ];
  const contrasted = warmed.map((channel) => clampByte(contrastFactor * (channel - 128) + 128 + adjustments.brightness * 2.55)) as [number, number, number];
  const hsl = rgbToHsl(contrasted);
  hsl.h = (hsl.h + adjustments.hue + 360) % 360;
  hsl.s = Math.max(0, Math.min(1, hsl.s * (1 + adjustments.saturation / 100)));
  return hslToRgb(hsl.h, hsl.s, hsl.l);
}

function mergeCloseLayerColors(
  cells: Array<string | null>,
  activePalette: NonNullable<ReturnType<typeof getColor>>[],
  strength: number,
): { cells: Array<string | null>; changed: number } {
  const stats = collectLayerColorStats(cells, activePalette);
  if (stats.length < 2) return { cells, changed: 0 };
  const level = Math.max(1, Math.min(4, Math.round(strength)));
  const replacements = new Map<string, string>();
  const sorted = [...stats].sort((a, b) => a.count - b.count);
  sorted.forEach((source) => {
    const target = stats
      .filter((candidate) => candidate.id !== source.id && candidate.count >= source.count)
      .map((candidate) => ({
        candidate,
        distance: colorDistance(source.color.rgb, candidate.color.rgb),
      }))
      .filter((item) => areLayerColorsClose(source.color, item.candidate.color, level))
      .sort((a, b) => {
        const aScore = a.distance - Math.min(18, Math.log2(a.candidate.count + 1) * 2.2);
        const bScore = b.distance - Math.min(18, Math.log2(b.candidate.count + 1) * 2.2);
        return aScore - bScore;
      })[0]?.candidate;
    if (target) replacements.set(source.id, replacements.get(target.id) ?? target.id);
  });
  if (replacements.size === 0) return { cells, changed: 0 };
  let changed = 0;
  const next = cells.map((colorId) => {
    if (!colorId) return null;
    const replacement = replacements.get(colorId);
    if (!replacement || replacement === colorId) return colorId;
    changed += 1;
    return replacement;
  });
  return { cells: next, changed };
}

function areLayerColorsClose(
  from: NonNullable<ReturnType<typeof getColor>>,
  to: NonNullable<ReturnType<typeof getColor>>,
  strength: number,
): boolean {
  const level = Math.max(1, Math.min(4, Math.round(strength)));
  const fromChroma = rgbChroma(from.rgb);
  const toChroma = rgbChroma(to.rgb);
  const fromLum = rgbLuminance(from.rgb);
  const toLum = rgbLuminance(to.rgb);
  const fromHsl = rgbToHsl(from.rgb);
  const toHsl = rgbToHsl(to.rgb);
  const neutral = fromChroma < 34 && toChroma < 34;
  const vivid = fromChroma > 72 || toChroma > 72;
  const luminanceGap = Math.abs(fromLum - toLum);
  const chromaGap = Math.abs(fromChroma - toChroma);
  const hueGap = Math.min(Math.abs(fromHsl.h - toHsl.h), 360 - Math.abs(fromHsl.h - toHsl.h));
  const distance = colorDistance(from.rgb, to.rgb);

  if (neutral) {
    return distance <= [0, 48, 68, 88, 108][level] && luminanceGap <= [0, 30, 44, 60, 76][level];
  }

  if (vivid && hueGap > [0, 12, 18, 28, 38][level]) return false;
  if (chromaGap > [0, 30, 44, 60, 76][level]) return false;
  if (luminanceGap > [0, 34, 50, 68, 84][level]) return false;

  const distanceLimit = vivid ? [0, 34, 50, 66, 82][level] : [0, 44, 64, 84, 104][level];
  if (distance <= distanceLimit) return true;

  return hueGap <= [0, 14, 24, 36, 48][level] && distance <= distanceLimit * 1.18;
}

function limitLayerColors(
  cells: Array<string | null>,
  activePalette: NonNullable<ReturnType<typeof getColor>>[],
  limit: number,
): { cells: Array<string | null>; changed: number } {
  const targetLimit = clampInteger(limit, 2, activePalette.length);
  const stats = collectLayerColorStats(cells, activePalette);
  if (stats.length <= targetLimit) return { cells, changed: 0 };
  const kept = selectLayerColorRepresentatives(stats, targetLimit);
  const keptIds = new Set(kept.map((row) => row.id));
  const keptColors = kept.map((row) => row.color);
  let changed = 0;
  const next = cells.map((colorId) => {
    if (!colorId || keptIds.has(colorId)) return colorId;
    const color = getColor(colorId);
    if (!color) return colorId;
    const replacement = nearestPaletteColor(color.rgb, keptColors).id;
    if (replacement !== colorId) changed += 1;
    return replacement;
  });
  return { cells: next, changed };
}

function applyEffectToLayer(
  cells: Array<string | null>,
  activePalette: NonNullable<ReturnType<typeof getColor>>[],
  effect: LayerEffect,
): { cells: Array<string | null>; changed: number } {
  const cache = new Map<string, string>();
  let changed = 0;
  const next = cells.map((colorId) => {
    if (!colorId) return null;
    const cached = cache.get(colorId);
    if (cached) {
      if (cached !== colorId) changed += 1;
      return cached;
    }
    const color = getColor(colorId);
    if (!color) return colorId;
    const mapped = nearestPaletteColor(effectRgb(color.rgb, effect), activePalette).id;
    cache.set(colorId, mapped);
    if (mapped !== colorId) changed += 1;
    return mapped;
  });
  return { cells: next, changed };
}

function effectRgb(rgb: [number, number, number], effect: LayerEffect): [number, number, number] {
  const luminance = clampByte(rgbLuminance(rgb));
  if (effect === 'invert') return [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]];
  if (effect === 'blackWhite') {
    const value = luminance >= 150 ? 255 : 0;
    return [value, value, value];
  }
  return [luminance, luminance, luminance];
}

function collectLayerColorStats(
  cells: Array<string | null>,
  activePalette: NonNullable<ReturnType<typeof getColor>>[],
): Array<{ id: string; color: NonNullable<ReturnType<typeof getColor>>; count: number }> {
  const paletteIds = new Set(activePalette.map((color) => color.id));
  const counts = new Map<string, number>();
  cells.forEach((colorId) => {
    if (!colorId) return;
    counts.set(colorId, (counts.get(colorId) ?? 0) + 1);
  });
  return [...counts.entries()]
    .flatMap(([id, count]) => {
      const color = getColor(id);
      if (!color) return [];
      const normalized = paletteIds.has(id) ? color : nearestPaletteColor(color.rgb, activePalette);
      return [{ id, color: normalized, count }];
    })
    .sort((a, b) => b.count - a.count);
}

function selectLayerColorRepresentatives(
  stats: Array<{ id: string; color: NonNullable<ReturnType<typeof getColor>>; count: number }>,
  limit: number,
) {
  const kept = [stats[0]];
  const keptIds = new Set([stats[0].id]);
  while (kept.length < limit) {
    const next = stats
      .filter((row) => !keptIds.has(row.id))
      .map((row) => {
        const nearestDistance = Math.min(...kept.map((item) => colorDistance(row.color.rgb, item.color.rgb)));
        const chroma = rgbChroma(row.color.rgb);
        const luminance = rgbLuminance(row.color.rgb);
        const accentBoost = chroma > 70 || luminance < 42 ? 1.8 : chroma > 45 ? 1.25 : 1;
        const score = Math.sqrt(row.count) * Math.max(0.4, nearestDistance / 18) * accentBoost;
        return { row, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.row;
    if (!next) break;
    kept.push(next);
    keptIds.add(next.id);
  }
  return kept;
}

function rgbChroma(rgb: [number, number, number]): number {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

function rgbLuminance(rgb: [number, number, number]): number {
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHsl([r, g, b]: [number, number, number]): { h: number; s: number; l: number } {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return { h: hue * 60, s: saturation, l: lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  if (saturation === 0) {
    const value = clampByte(lightness * 255);
    return [value, value, value];
  }
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const hk = hue / 360;
  const convert = (t: number) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return [clampByte(convert(hk + 1 / 3) * 255), clampByte(convert(hk) * 255), clampByte(convert(hk - 1 / 3) * 255)];
}

function clampInteger(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v9" />
      <path d="m6.8 8.8 3.2 3.2 3.2-3.2" />
      <path d="M4 13.2v2.6c0 .7.5 1.2 1.2 1.2h9.6c.7 0 1.2-.5 1.2-1.2v-2.6" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.48.08.66-.2.66-.46v-1.7c-2.68.58-3.25-1.14-3.25-1.14-.44-1.1-1.07-1.4-1.07-1.4-.88-.6.07-.58.07-.58.97.07 1.48 1 1.48 1 .86 1.47 2.25 1.04 2.8.8.09-.62.34-1.04.61-1.28-2.14-.24-4.39-1.07-4.39-4.76 0-1.05.38-1.91 1-2.58-.1-.25-.43-1.24.1-2.55 0 0 .81-.26 2.66.99a9.16 9.16 0 0 1 4.84 0c1.85-1.25 2.66-.99 2.66-.99.53 1.31.2 2.3.1 2.55.62.67 1 1.53 1 2.58 0 3.7-2.26 4.51-4.4 4.75.35.3.66.9.66 1.81v2.5c0 .26.17.55.67.46A9.5 9.5 0 0 0 12 2.5z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6 6l8 8" />
      <path d="M14 6l-8 8" />
    </svg>
  );
}

function resizeCells(
  cells: Array<string | null>,
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number,
): Array<string | null> {
  const next = Array.from({ length: newWidth * newHeight }, () => null as string | null);
  const copyWidth = Math.min(oldWidth, newWidth);
  const copyHeight = Math.min(oldHeight, newHeight);
  for (let y = 0; y < copyHeight; y += 1) {
    for (let x = 0; x < copyWidth; x += 1) {
      next[y * newWidth + x] = cells[y * oldWidth + x] ?? null;
    }
  }
  return next;
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5.5" y="10" width="13" height="10" rx="2" />
      <path d={locked ? 'M8.5 10V7.7a3.5 3.5 0 017 0V10' : 'M8.5 10V7.7a3.5 3.5 0 016.4-2'} />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20l4.6-1 9.8-9.8-3.6-3.6L5 15.4 4 20z" />
      <path d="M13.8 4.6l1.5-1.5c.7-.7 1.8-.7 2.5 0l1.1 1.1c.7.7.7 1.8 0 2.5l-1.5 1.5" />
    </svg>
  );
}

function DuplicateIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M5 16V6.8C5 5.8 5.8 5 6.8 5H16" />
    </svg>
  );
}

function DragHandleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5h.1M15 5h.1M9 12h.1M15 12h.1M9 19h.1M15 19h.1" />
    </svg>
  );
}

function EyeIcon({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.8 12s3.3-5.5 9.2-5.5 9.2 5.5 9.2 5.5-3.3 5.5-9.2 5.5S2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.5" />
      {!visible && <path d="M4 4l16 16" />}
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M9 7V4.8h6V7" />
      <path d="M7 7l.8 13h8.4L17 7" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 11a7.5 7.5 0 1 1 2.2 5.3" />
      <path d="M4.5 5.5V11h5.5" />
    </svg>
  );
}

function ClipboardPreview({ pattern }: { pattern: ClipboardPattern }) {
  const maxSide = Math.max(pattern.width, pattern.height, 1);
  const beadSize = Math.max(3, Math.min(10, Math.floor(76 / maxSide)));
  return (
    <div
      className="clipboard-preview"
      style={{
        gridTemplateColumns: `repeat(${pattern.width}, ${beadSize}px)`,
        gridAutoRows: `${beadSize}px`,
      }}
      aria-hidden="true"
    >
      {pattern.cells.map((colorId, index) => {
        const color = colorId ? getColor(colorId) : null;
        return <span key={index} style={{ background: color?.hex ?? 'transparent' }} />;
      })}
    </div>
  );
}

function ToolIcon({ tool }: { tool: ToolId }) {
  if (tool === 'pencil') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 20l4.7-1 9.8-9.8-3.7-3.7L5 15.3 4 20z" />
        <path d="M13.8 4.5l1.7-1.7c.7-.7 1.8-.7 2.5 0l1.2 1.2c.7.7.7 1.8 0 2.5l-1.7 1.7" />
      </svg>
    );
  }
  if (tool === 'eraser') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.3 14.6l7.9-7.9c.8-.8 2-.8 2.8 0l4.3 4.3c.8.8.8 2 0 2.8l-5.9 5.9H8.6l-4.3-4.3c-.2-.2-.2-.6 0-.8z" />
        <path d="M9.8 19.7h10" />
      </svg>
    );
  }
  if (tool === 'fill') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5l6.5-6.5 7 7-6 6c-.8.8-2 .8-2.8 0L5 14.3c-.5-.5-.5-1.3 0-1.8z" />
        <path d="M8.5 8.5l-2-2" />
        <path d="M17.5 17.2c.8 1.1 1.2 1.9 1.2 2.4 0 1-.7 1.6-1.6 1.6s-1.6-.6-1.6-1.6c0-.5.4-1.3 1.2-2.4.2-.3.6-.3.8 0z" />
      </svg>
    );
  }
  if (tool === 'remove') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5l6.5-6.5 7 7-6 6c-.8.8-2 .8-2.8 0L5 14.3c-.5-.5-.5-1.3 0-1.8z" />
        <path d="M8.5 8.5l-2-2" />
        <path d="M15.5 17.5l4 4M19.5 17.5l-4 4" />
      </svg>
    );
  }
  if (tool === 'recolor') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 7.5h7.2c2.2 0 4 1.8 4 4v.3" />
        <path d="M9 4.5 6 7.5l3 3" />
        <path d="M18 16.5h-7.2c-2.2 0-4-1.8-4-4v-.3" />
        <path d="M15 19.5l3-3-3-3" />
        <path d="M8 16.2c.9 1.2 1.3 2 1.3 2.6 0 1-.7 1.7-1.7 1.7S6 19.8 6 18.8c0-.6.4-1.4 1.3-2.6.2-.3.5-.3.7 0z" />
      </svg>
    );
  }
  if (tool === 'eyedropper') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.8 4.3l4.9 4.9-3.1 3.1-1.5-1.5-7.9 7.9H4.8v-2.4l7.9-7.9-1.1-1.1 3.2-3z" />
        <path d="M5 20h6" />
      </svg>
    );
  }
  if (tool === 'move') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v18" />
        <path d="M8.5 6.5 12 3l3.5 3.5" />
        <path d="M8.5 17.5 12 21l3.5-3.5" />
        <path d="M3 12h18" />
        <path d="M6.5 8.5 3 12l3.5 3.5" />
        <path d="M17.5 8.5 21 12l-3.5 3.5" />
      </svg>
    );
  }
  if (tool === 'copy') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M5 16V6.8C5 5.8 5.8 5 6.8 5H16" />
        <path d="M11 12h5M13.5 9.5v5" />
      </svg>
    );
  }
  if (tool === 'paste') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 5h6l1 2h2.2c.9 0 1.8.8 1.8 1.8v9.4c0 1-.8 1.8-1.8 1.8H5.8c-1 0-1.8-.8-1.8-1.8V8.8C4 7.8 4.8 7 5.8 7H8z" />
        <path d="M9 5c0-1.1.8-2 2-2h2c1.2 0 2 .9 2 2" />
        <path d="M8 12h8M8 16h5" />
      </svg>
    );
  }
  if (tool === 'mirror') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4v16" />
        <path d="M5 7.5h4v9H5z" />
        <path d="M19 7.5h-4v9h4z" />
        <path d="M9 12h6" />
        <path d="M7 5.5 5 7.5l2 2" />
        <path d="M17 5.5l2 2-2 2" />
      </svg>
    );
  }
  if (tool === 'shape') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 16.5 9 8.5l4 7.5z" />
        <path d="M13.8 5.2h5v5h-5z" />
        <path d="M14.8 17.4a2.8 2.8 0 1 0 5.6 0 2.8 2.8 0 0 0-5.6 0z" />
      </svg>
    );
  }
  if (tool === 'text') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 6h14" />
        <path d="M12 6v12" />
        <path d="M8.5 18h7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.5 11.5V6.8a2 2 0 0 1 4 0v4.5" />
      <path d="M12.5 11V5.5a2 2 0 0 1 4 0V12" />
      <path d="M16.5 12V8.2a2 2 0 0 1 4 0v6.3c0 3.8-2.7 6.5-6.7 6.5h-1.5c-2.1 0-3.6-.8-4.9-2.4L4.6 15c-.6-.8-.4-1.9.4-2.4.6-.4 1.4-.3 1.9.2l1.6 1.7v-3z" />
    </svg>
  );
}

function ShapeOptionIcon({ shape }: { shape: ShapeKind }) {
  if (shape === 'line') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 19 19 5" />
      </svg>
    );
  }
  if (shape === 'rectangle') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 7h14v10H5z" />
      </svg>
    );
  }
  if (shape === 'square') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.5 6.5h11v11h-11z" />
      </svg>
    );
  }
  if (shape === 'ellipse') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 12a7.5 5.2 0 1 0 15 0 7.5 5.2 0 0 0-15 0z" />
      </svg>
    );
  }
  if (shape === 'circle') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5.5 12a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z" />
      </svg>
    );
  }
  if (shape === 'triangle') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5 19 18H5z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h12" />
      <path d="M13 8l4 4-4 4" />
    </svg>
  );
}

function ArrowOptionIcon({ arrow }: { arrow: ArrowKind }) {
  if (arrow === 'double') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 12h12" />
        <path d="M10 8 6 12l4 4" />
        <path d="M14 8l4 4-4 4" />
      </svg>
    );
  }
  if (arrow === 'block') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 9h8V6l6 6-6 6v-3H5z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h12" />
      <path d="M13 8l4 4-4 4" />
    </svg>
  );
}

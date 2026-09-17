import type { BeadLayer } from './types';

export type RecolorScope = 'all' | 'selection';
// Inclusive grid coordinates: a click selects one cell.
export type GridSelectionRect = { left: number; top: number; right: number; bottom: number };

export function selectionRectFromPoints(
  start: { x: number; y: number }, end: { x: number; y: number }, width: number, height: number,
): GridSelectionRect {
  const clampX = (x: number) => Math.max(0, Math.min(width - 1, Math.floor(x)));
  const clampY = (y: number) => Math.max(0, Math.min(height - 1, Math.floor(y)));
  return {
    left: clampX(Math.min(start.x, end.x)), right: clampX(Math.max(start.x, end.x)),
    top: clampY(Math.min(start.y, end.y)), bottom: clampY(Math.max(start.y, end.y)),
  };
}

export function inSelectionRect(index: number, width: number, rect: GridSelectionRect): boolean {
  const x = index % width;
  const y = Math.floor(index / width);
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// Callers supply the displayed visibility (including active-layer-only mode).
export function recolorLayers(
  layers: BeadLayer[], width: number, sourceColorId: string, targetColorId: string,
  rect: GridSelectionRect | null = null,
): { layers: BeadLayer[]; changed: number } {
  let changed = 0;
  if (!sourceColorId || sourceColorId === targetColorId) return { layers, changed };
  const nextLayers = layers.map(layer => {
    if (layer.locked || !layer.visible) return layer;
    let layerChanged = false;
    const cells = layer.cells.map((cell, index) => {
      if (cell !== sourceColorId || (rect && !inSelectionRect(index, width, rect))) return cell;
      changed++;
      layerChanged = true;
      return targetColorId;
    });
    return layerChanged ? { ...layer, cells } : layer;
  });
  return { layers: nextLayers, changed };
}

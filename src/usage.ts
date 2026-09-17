import { composeVisibleCells, projectColor } from './project';
import type { BeadProject, UsageRow } from './types';

export function summarizeUsage(project: BeadProject): UsageRow[] {
  const cells = project.layers?.length ? composeVisibleCells(project.layers, project.width, project.height) : project.cells;
  const counts = new Map<string, number>();
  for (const cell of cells) {
    if (cell) counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([id, count]) => {
      const color = projectColor(project, id);
      if (!color) return null;
      return {
        color,
        count,
        packs: Math.ceil(count / project.settings.beadsPerPack),
      };
    })
    .filter((row): row is UsageRow => Boolean(row))
    .sort((a, b) => b.count - a.count || a.color.primaryCode.localeCompare(b.color.primaryCode));
}

export function findIsolatedBeads(project: BeadProject): Array<{ layerId: string; index: number }> {
  const usageLayers = (project.layers ?? []).filter((layer) => layer.includeInUsage);
  const isolated: Array<{ layerId: string; index: number }> = [];
  for (const layer of usageLayers) {
    const cells = layer.cells;
    for (let y = 0; y < project.height; y += 1) {
      for (let x = 0; x < project.width; x += 1) {
        const index = y * project.width + x;
        const id = cells[y * project.width + x];
        if (!id) continue;
        const neighbors = [
          x > 0 ? cells[y * project.width + x - 1] : null,
          x < project.width - 1 ? cells[y * project.width + x + 1] : null,
          y > 0 ? cells[(y - 1) * project.width + x] : null,
          y < project.height - 1 ? cells[(y + 1) * project.width + x] : null,
        ];
        if (!neighbors.some(Boolean)) isolated.push({ layerId: layer.id, index });
      }
    }
  }
  return isolated;
}

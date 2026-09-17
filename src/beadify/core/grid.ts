import type { BeadPattern, ColorId } from '../contracts';

export function inspectCells(cells: readonly (ColorId | null)[], width: number, height: number): Pick<BeadPattern['diagnostics'], 'usedColors' | 'physicalComponents' | 'monochromeSingletons'> {
  const seen = new Uint8Array(cells.length);
  const colors = new Set<ColorId>();
  let physicalComponents = 0, monochromeSingletons = 0;
  const neighbors = (index: number): number[] => {
    const x = index % width, y = Math.floor(index / width);
    const result: number[] = [];
    if (x > 0) result.push(index - 1);
    if (x + 1 < width) result.push(index + 1);
    if (y > 0) result.push(index - width);
    if (y + 1 < height) result.push(index + width);
    return result;
  };
  for (let index = 0; index < cells.length; index++) {
    const color = cells[index];
    if (color === null) continue;
    colors.add(color);
    if (!neighbors(index).some(next => cells[next] === color)) monochromeSingletons++;
    if (seen[index]) continue;
    physicalComponents++;
    const stack = [index];
    seen[index] = 1;
    while (stack.length) {
      const current = stack.pop()!;
      for (const next of neighbors(current)) {
        if (!seen[next] && cells[next] !== null) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
  }
  return { usedColors: colors.size, physicalComponents, monochromeSingletons };
}

/** Conservative manufacturing hints. A narrow connection is an occupied cell
 * with exactly two opposite occupied neighbors, not a proven articulation point. */
export function inspectConnectivity(cells: readonly (ColorId | null)[], width: number, height: number): { diagonalContacts: number; narrowConnections: number } {
  let diagonalContacts = 0, narrowConnections = 0;
  const occupied = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && cells[y * width + x] !== null;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!occupied(x, y)) continue;
    const left = occupied(x - 1, y), right = occupied(x + 1, y), up = occupied(x, y - 1), down = occupied(x, y + 1);
    if ((left && right && !up && !down) || (up && down && !left && !right)) narrowConnections++;
    if (occupied(x + 1, y + 1) && !right && !down) diagonalContacts++;
    if (occupied(x - 1, y + 1) && !left && !down) diagonalContacts++;
  }
  return { diagonalContacts, narrowConnections };
}

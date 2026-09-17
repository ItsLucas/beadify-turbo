/** Generated JSON types are the interchange contract; this sole adapter adds an in-memory buffer. */
import type { CellConstraint as CellConstraintJson, GenerationRequestJson, RgbaImageJson, SourceFeatureRegion as SourceFeatureJson, SourceRaster as SourceRasterJson, RasterCell as RasterCellJson, RasterMode as RasterModeJson, SourceComponentEvidence } from './generated';

export type * from './generated';
export type RgbaImage = Omit<RgbaImageJson, 'data'> & { data: number[] | Uint8ClampedArray };
/** Editors build arrays incrementally; runtime validation enforces nonempty selections. */
export type CellConstraint = Omit<CellConstraintJson, 'cellIndices' | 'colorIds'> & { cellIndices: number[]; colorIds?: string[] };
export type SourceFeatureRegion = Omit<SourceFeatureJson, 'colorIds' | 'mask'> & { colorIds: string[]; mask: { width: number; height: number; runs: [number, number][] } };
export type RasterMode = Omit<RasterModeJson, 'components'> & { components?: SourceComponentEvidence[] };
export type RasterCell = Omit<RasterCellJson, 'modes'> & { modes: RasterMode[] };
export type SourceRaster = Omit<SourceRasterJson, 'cells' | 'features'> & { cells: (RasterCell | null)[]; features: CellConstraint[] };
export type GenerationRequest = Omit<GenerationRequestJson, 'image' | 'constraints' | 'sourceFeatures' | 'preparedRaster'> & { image: RgbaImage; constraints?: CellConstraint[]; sourceFeatures?: SourceFeatureRegion[]; preparedRaster?: SourceRaster };

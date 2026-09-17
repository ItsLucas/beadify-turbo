/** Runtime observers are separate from request data and never enter hashes. */
export type CoreProgress = {
  stage: 'sampling' | 'optimizing' | 'finalizing' | 'text-evidence' | 'source-cache' | 'text-extraction' | 'complete';
  completed: number; total: number; evaluations?: number; maxEvaluations?: number;
};
export type ProgressObserver = (progress: CoreProgress) => void;

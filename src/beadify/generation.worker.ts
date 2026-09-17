import { generatePattern, createSourceRaster, generateTextCandidate } from './core/index';
import { extractTextEvidence } from './core/text-extraction';
import type { WorkerRequest, WorkerResponse } from './worker-client';
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};
scope.onmessage = ({ data }) => {
  if (data.type !== 'generate' && data.type !== 'prepare' && data.type !== 'generate-text') return;
  try {
    const progress = (value: import('./core/progress').CoreProgress) => scope.postMessage({ type: 'progress', taskId: data.taskId, revision: data.request.revision, progress: value });
    if (data.type === 'prepare') {
      progress({ stage: 'source-cache', completed: 0, total: 1 });
      const raster = createSourceRaster(data.request, data.sourceHash);
      progress({ stage: 'complete', completed: 1, total: 1 });
      scope.postMessage({ type: 'prepared', taskId: data.taskId, revision: data.request.revision, raster });
      return;
    }
    if (data.type === 'generate-text') {
      progress({ stage: 'text-extraction', completed: 0, total: 5 });
      const extracted = data.text.extractEvidence ? extractTextEvidence(data.text.analysis, data.request.image) : undefined;
      const result = { ...generateTextCandidate(data.request, extracted?.analysis ?? data.text.analysis, data.text.initialPattern,
        value => progress({ ...value, completed: 1 + value.completed / value.total * 4, total: 5 })),
        ...(extracted ? { analysis: extracted.analysis, extraction: extracted.diagnostics } : {}) };
      progress({ stage: 'complete', completed: 5, total: 5 });
      scope.postMessage({ type: 'text-result', taskId: data.taskId, revision: data.request.revision, result });
      return;
    }
    const pattern = generatePattern(data.request, progress);
    scope.postMessage({ type: 'result', taskId: data.taskId, revision: data.request.revision, pattern });
  } catch (error) {
    const details = error as { code?: string; conflicts?: unknown[] };
    scope.postMessage({ type: 'error', taskId: data.taskId, message: error instanceof Error ? error.message : 'Generation failed', ...(details?.code ? { code: details.code } : {}), ...(Array.isArray(details?.conflicts) ? { conflicts: details.conflicts } : {}) });
  }
};

import type { BeadPattern, GenerationRequest, SourceRaster, TextAnalysis } from './contracts/index';
import type { generateTextCandidate } from './core/index';
import type { extractTextEvidence } from './core/text-extraction';
import type { CoreProgress, ProgressObserver } from './core/progress';

export type TextCandidateResult = ReturnType<typeof generateTextCandidate> & { analysis?: TextAnalysis; extraction?: ReturnType<typeof extractTextEvidence>['diagnostics'] };
type TextTask = { analysis: TextAnalysis; initialPattern?: BeadPattern; extractEvidence?: boolean };

export type WorkerRequest = { type: 'generate'; taskId: number; request: GenerationRequest } | { type: 'prepare'; taskId: number; request: GenerationRequest; sourceHash: string }
  | { type: 'generate-text'; taskId: number; request: GenerationRequest; text: TextTask };
export type WorkerResponse =
  | { type: 'progress'; taskId: number; revision: number; progress: CoreProgress }
  | { type: 'result'; taskId: number; revision: number; pattern: BeadPattern }
  | { type: 'prepared'; taskId: number; revision: number; raster: SourceRaster }
  | { type: 'text-result'; taskId: number; revision: number; result: TextCandidateResult }
  | { type: 'error'; taskId: number; message: string; code?: string; conflicts?: unknown[] };

export class GenerationWorkerClient {
  private worker: Worker | null = null;
  private rejectPending: ((reason: Error) => void) | null = null;
  private taskId = 0;

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    this.rejectPending?.(new Error('Generation cancelled'));
    this.rejectPending = null;
  }

  generate(request: GenerationRequest, onProgress?: ProgressObserver): Promise<BeadPattern> {
    return this.start(request, undefined, undefined, onProgress) as Promise<BeadPattern>;
  }

  prepareSource(request: GenerationRequest, sourceHash: string, onProgress?: ProgressObserver): Promise<SourceRaster> {
    return this.start(request, sourceHash, undefined, onProgress) as Promise<SourceRaster>;
  }

  generateText(request: GenerationRequest, analysis: TextAnalysis, initialPattern?: BeadPattern, extractEvidence = false, onProgress?: ProgressObserver): Promise<TextCandidateResult> {
    return this.start(request, undefined, { analysis, initialPattern, extractEvidence }, onProgress) as Promise<TextCandidateResult>;
  }

  private start(request: GenerationRequest, sourceHash?: string, text?: TextTask, onProgress?: ProgressObserver): Promise<BeadPattern | SourceRaster | TextCandidateResult> {
    this.cancel();
    const taskId = ++this.taskId;
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./generation.worker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      this.rejectPending = reject;
      const finish = () => {
        worker.terminate();
        if (this.worker === worker) { this.worker = null; this.rejectPending = null; }
      };
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        if (this.worker !== worker || response.taskId !== taskId) return;
        if (response.type === 'progress') {
          if (response.revision === request.revision) onProgress?.(response.progress);
          return;
        }
        if (response.type === 'text-result' && text && response.revision === request.revision) {
          finish(); resolve(response.result);
        } else if (!text && (response.type === 'result' || response.type === 'prepared') && response.revision === request.revision && (response.type === 'prepared') === (sourceHash !== undefined)) {
          finish(); resolve(response.type === 'result' ? response.pattern : response.raster);
        } else {
          finish();
          const error = new Error(response.type === 'error' ? response.message : 'Stale worker revision');
          if (response.type === 'error') Object.assign(error, { code: response.code, conflicts: response.conflicts });
          reject(error);
        }
      };
      worker.onerror = (event) => { finish(); reject(new Error(event.message || 'Worker failed')); };
      // The caller retains its original buffer for subsequent generations.
      if (request.image.data instanceof Uint8ClampedArray) {
        const data = new Uint8ClampedArray(request.image.data);
        const copied = { ...request, image: { ...request.image, data } };
        const message: WorkerRequest = text ? { type: 'generate-text', taskId, request: copied, text } : sourceHash === undefined ? { type: 'generate', taskId, request: copied } : { type: 'prepare', taskId, request: copied, sourceHash };
        worker.postMessage(message, [data.buffer]);
      } else {
        // Preserve invalid JSON bytes so the same core validation rejects them.
        const message: WorkerRequest = text ? { type: 'generate-text', taskId, request, text } : sourceHash === undefined ? { type: 'generate', taskId, request } : { type: 'prepare', taskId, request, sourceHash };
        worker.postMessage(message);
      }
    });
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationSession } from '../src/beadify/generation-session';
import { GenerationWorkerClient } from '../src/beadify/worker-client';
import type { GenerationRequest } from '../src/beadify/contracts/index';
import { generatePattern, generateTextCandidate } from '../src/beadify/core';
import { createTextFixtures, textFixtureRequest } from '../benchmark/text-fixtures';
import { readFileSync } from 'node:fs';
import type { CoreProgress } from '../src/beadify/core/progress';

test('new requests and document/input revisions reject stale completions and candidates', () => {
  const session = new GenerationSession();
  const first = session.begin();
  const second = session.begin();
  assert.equal(session.isCurrent(first), false);
  assert.equal(session.isCurrent(second), true);
  session.invalidate(); // manual edit / undo / import / change parameters / cancel
  assert.equal(session.isCurrent(second), false);
  const afterEdit = session.begin();
  assert.equal(afterEdit.revision, second.revision + 1);
  assert.equal(session.isCurrent(afterEdit), true);
});

test('worker cancellation terminates CPU work, settles callers, and retains original RGBA', async () => {
  const workers: any[] = [];
  class FakeWorker {
    onmessage: any; onerror: any; terminated = false; message: any;
    constructor() { workers.push(this); }
    terminate() { this.terminated = true; }
    postMessage(message: any, transfers: any[] = []) { this.message = structuredClone(message, { transfer: transfers }); }
  }
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker as any;
  try {
    const client = new GenerationWorkerClient();
    const bytes = new Uint8ClampedArray([255, 0, 0, 255]);
    const request = { revision: 7, image: { width: 1, height: 1, data: bytes } } as GenerationRequest;
    const cancelled = client.generate(request);
    const rejection = assert.rejects(cancelled, /cancelled/);
    client.cancel();
    await rejection;
    assert.equal(workers[0].terminated, true);
    assert.equal(bytes.byteLength, 4);
    const progress: unknown[] = [];
    const next = client.generate(request, value => progress.push(value));
    const taskId = workers[1].message.taskId;
    workers[0].onmessage({ data: { type: 'progress', taskId: 1, revision: 7, progress: 'stale' } });
    workers[1].onmessage({ data: { type: 'progress', taskId, revision: 6, progress: 'wrong revision' } });
    workers[1].onmessage({ data: { type: 'progress', taskId, revision: 7, progress: 'current progress' } });
    assert.deepEqual(progress, ['current progress']);
    workers[0].onmessage({ data: { type: 'result', taskId: 1, revision: 7, pattern: 'stale' } });
    workers[1].onmessage({ data: { type: 'result', taskId, revision: 7, pattern: 'current' } });
    assert.equal(await next, 'current');
    const mismatch = client.generate(request);
    const mismatchRejection = assert.rejects(mismatch, /revision/);
    workers[2].onmessage({ data: { type: 'result', taskId: workers[2].message.taskId, revision: 6, pattern: 'wrong revision' } });
    await mismatchRejection;
  } finally { globalThis.Worker = original; }
});

test('generation observers report real work monotonically without changing ordinary or text outputs', () => {
  const fixture = createTextFixtures().find(f => f.id === 'disconnected-han')!;
  const request = { ...textFixtureRequest(fixture.image, 24), optimization: { maxEvaluations: 3000 } };
  const analysis = JSON.parse(readFileSync('benchmark/text/interfaces-v1/disconnected-han.analysis.json', 'utf8'));
  const ordinary = generatePattern(request), updates: CoreProgress[] = [];
  assert.deepEqual(generatePattern(request, p => updates.push(p)), ordinary);
  assert.ok(updates.some(p => p.stage === 'optimizing' && p.evaluations !== undefined));
  for (let i = 1; i < updates.length; i++) assert.ok(updates[i].completed / updates[i].total >= updates[i - 1].completed / updates[i - 1].total);
  assert.equal(updates.at(-1)!.completed / updates.at(-1)!.total, 1);
  const text = generateTextCandidate(request, analysis, ordinary), textUpdates: CoreProgress[] = [];
  assert.deepEqual(generateTextCandidate(request, analysis, ordinary, p => textUpdates.push(p)), text);
  for (let i = 1; i < textUpdates.length; i++) assert.ok(textUpdates[i].completed / textUpdates[i].total >= textUpdates[i - 1].completed / textUpdates[i - 1].total);
  assert.equal(textUpdates.at(-1)!.completed / textUpdates.at(-1)!.total, 1);
});

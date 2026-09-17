import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyTextAnalysis, matchingText, resealText, updateTextRegion } from '../src/beadify/text-web';
import { autosaveKey, createProject, normalizeProject, serializeProject, saveDraftWithStatus, withCells } from '../src/project';
import { workspacePalette } from '../src/beadify/adapter';
import { basicPalette } from '../src/palette';
import type { TextAnalysis } from '../src/beadify/contracts';
import { textCoreEvidenceHash, validateTextAnalysis } from '../src/beadify/core/text-analysis';

test('project text record survives grid edits, serialization and reopening, with independent source identity', () => {
  const analysis: TextAnalysis = JSON.parse(readFileSync('benchmark/text/interfaces-v1/disconnected-han.analysis.json', 'utf8'));
  const project = createProject(2, 2);
  project.beadify = { schemaVersion: 1, paletteSnapshot: workspacePalette(basicPalette), lastGeneration: { method: 'optimized', inputRevision: 1, configHash: null }, textAnalysis: analysis };
  const edited = withCells(project, ['mard-h7', null, null, null]);
  const restored = normalizeProject(JSON.parse(serializeProject(edited)));
  assert.deepEqual(restored.beadify!.textAnalysis, analysis);
  assert.deepEqual(restored.cells, edited.cells);
  const corrupted = JSON.parse(serializeProject(edited)); corrupted.beadify.textAnalysis.regions[0].transcription += 'tampered';
  assert.throws(() => normalizeProject(corrupted), /integrity/);
});

test('manual records bind to original RGBA and corrections do not alter source evidence', () => {
  const image = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) };
  const empty = emptyTextAnalysis(image); assert.equal(matchingText(empty, image), true);
  assert.equal(matchingText(empty, { ...image, data: new Uint8ClampedArray(16) }), false);
  const record: TextAnalysis = JSON.parse(readFileSync('benchmark/text/interfaces-v1/disconnected-han.analysis.json', 'utf8'));
  const corrected = resealText({ ...record, corrections: [{ regionId: record.regions[0].id, transcription: '校正', origin: 'manual' }] });
  assert.notEqual(record.contentHash, corrected.contentHash);
  assert.equal(textCoreEvidenceHash(record), textCoreEvidenceHash(corrected));
  const excluded = updateTextRegion(corrected, record.regions[0].id, 'artwork');
  assert.equal(excluded.evidence.some(e => e.regionId === record.regions[0].id), false);
  const removed = updateTextRegion(corrected, record.regions[0].id, 'delete');
  validateTextAnalysis(removed);
  assert.equal(removed.corrections.length, 0);
});

test('quota fallback preserves the editable grid and explicitly marks omitted text analysis without mutating it', () => {
  const project = withCells(createProject(2, 2), ['mard-h7', null, null, null]);
  const analysis = emptyTextAnalysis({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) });
  project.beadify = { schemaVersion: 1, paletteSnapshot: workspacePalette(basicPalette), lastGeneration: { method: 'optimized', inputRevision: 1, configHash: null }, textAnalysis: analysis };
  const noAnalysis = { ...project, beadify: { ...project.beadify, textAnalysis: undefined } };
  const quota = Buffer.byteLength(serializeProject(noAnalysis)) + 128;
  let saved = '', attempts = 0;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem(key: string, value: string) {
    assert.equal(key, autosaveKey); attempts++;
    if (Buffer.byteLength(value) > quota) throw new DOMException('Quota reached', 'QuotaExceededError'); saved = value;
  } } });
  try {
    const status = saveDraftWithStatus(project);
    assert.equal(status.saved, true); assert.equal(status.textAnalysisOmitted, true); assert.equal(attempts, 2);
    const restored = normalizeProject(JSON.parse(saved));
    assert.deepEqual(restored.cells, project.cells);
    assert.equal(restored.beadify!.textAnalysis, undefined);
    assert.equal(restored.beadify!.textAnalysisOmission, 'storage-quota');
    assert.deepEqual(project.beadify!.textAnalysis, analysis);
    assert.deepEqual(normalizeProject(JSON.parse(serializeProject(project))).beadify!.textAnalysis, analysis);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete (globalThis as { localStorage?: unknown }).localStorage; }
});

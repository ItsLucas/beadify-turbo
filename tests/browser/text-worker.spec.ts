import { assertPatternEquivalent } from '../support/pattern-assertions';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { createTextFixtures, textFixtureRequest } from '../../benchmark/text-fixtures';
import { generatePattern, generateTextCandidate, toJsonRequest } from '../../src/beadify/core';
import type { TextAnalysis } from '../../src/beadify/contracts';

test('text candidate in a real Worker equals Node and survives cancellation/rejection', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = createTextFixtures().find(f => f.id === 'disconnected-han')!;
  const analysis: TextAnalysis = JSON.parse(readFileSync('benchmark/text/interfaces-v1/disconnected-han.analysis.json', 'utf8'));
  const request = toJsonRequest(textFixtureRequest(fixture.image, 40)), base = generatePattern(request), expected = generateTextCandidate(request, analysis, base);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const actual = await page.evaluate(async ({ request, analysis, base }) => {
    const { GenerationWorkerClient } = await import('/src/beadify/worker-client.js');
    const client = new GenerationWorkerClient();
    const result = await client.generateText(request, analysis, base);
    const pending = client.generateText(request, analysis, base).then(() => 'unexpected result', (error: Error) => error.message);
    client.cancel(); const cancellation = await pending;
    const invalid = { ...analysis, contentHash: `sha256:${'0'.repeat(64)}` };
    const rejection = await client.generateText(request, invalid, base).then(() => 'unexpected result', (error: Error) => error.message);
    const ordinary = await client.generate(request);
    return { result, cancellation, rejection, ordinary };
  }, { request, analysis, base });
  assertPatternEquivalent(actual.result, expected); expect(actual.cancellation).toContain('cancelled'); expect(actual.rejection).toContain('integrity'); assertPatternEquivalent(actual.ordinary, base); expect(errors).toEqual([]);
});

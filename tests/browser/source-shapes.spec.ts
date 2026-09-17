import { assertPatternEquivalent } from '../support/pattern-assertions';
import { test, expect } from '@playwright/test';
import { createFixtures } from '../../benchmark/g2-next-fixtures';
import { createSourceRaster, generatePattern } from '../../src/beadify/core';
import type { GenerationRequest } from '../../src/beadify/contracts';

// These inputs carry only original pixels and generation settings. The analytic
// masks used by the separate quality benchmark never cross the Worker boundary.
for (const family of ['variable-curve', 'eye-outline-hole', 'enclosed-accent-k6'] as const) {
  test(`v5 ${family} source evidence and cached optimization match Node in a real Worker`, async ({ page, baseURL }) => {
    test.setTimeout(60_000);
    const errors: string[] = [], external: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(`${baseURL}/`) && !request.url().startsWith('data:')) external.push(request.url()); });
    await page.goto('/');
    const fixture = createFixtures().find(fixture => fixture.family === family && fixture.scale === 8 && fixture.phase[0] === 0)!;
    const input: GenerationRequest = { ...fixture.request, image: { ...fixture.request.image, data: Array.from(fixture.request.image.data) },
      sampling: { ...fixture.request.sampling, crossBinStrokes: true },
      optimization: { ...fixture.request.optimization, sourceShapes: true, sourceColors: true } };
    const expected = generatePattern(input), raster = createSourceRaster(input);
    expect(raster.algorithmVersion).toBe(5);
    const evidence = raster.cells.flatMap(cell => cell?.modes.flatMap(mode => mode.components ?? []) ?? []);
    if (family === 'variable-curve') {
      expect(evidence.some(component => component.kind === 'stroke' && (component.endpointMask ?? 0) > 0)).toBe(true);
    } else if (family === 'eye-outline-hole') {
      expect(evidence.some(component => component.kind === 'stroke' && component.closed)).toBe(true);
    } else expect(evidence.some(component => component.kind === 'region')).toBe(true);
    // Exercise serialized source replay and persisted ablation flags as well as
    // fresh sampling, so optional metadata cannot silently disappear in transit.
    const { sampling: _sampling, phase: _phase, preprocessing: _preprocessing, sourceFeatures: _sourceFeatures, ...cachedBase } = input;
    const cachedInput: GenerationRequest = { ...cachedBase, preparedRaster: JSON.parse(JSON.stringify(raster)),
      optimization: { ...input.optimization, sourceShapes: false, sourceColors: false } };
    const expectedCached = generatePattern(cachedInput);
    const actual = await page.evaluate(async ({ input, cachedInput, sourceHash }) => {
      const { GenerationWorkerClient } = await import('/src/beadify/worker-client.js');
      const client = new GenerationWorkerClient();
      const fresh = await client.generate(input), source = await client.prepareSource(input, sourceHash);
      const cached = await client.generate(cachedInput);
      return { fresh, source, cached };
    }, { input, cachedInput, sourceHash: raster.sourceHash });
    assertPatternEquivalent(actual.fresh, expected);
    expect(actual.source).toEqual(raster);
    assertPatternEquivalent(actual.cached, expectedCached);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}

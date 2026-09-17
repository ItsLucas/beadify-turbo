#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GenerationRequest, TextAnalysis } from '../src/beadify/contracts';
import { buildBom, extractTextEvidence, generatePattern, generateTextCandidate, validateTextAnalysis } from '../src/beadify/core';
import { workspacePalette } from '../src/beadify/adapter';
import { basicPalette } from '../src/palette';
import { decodeTextImage, textPatternPng } from './text-tools';

const args = process.argv.slice(2), options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!['--input', '--analysis', '--width', '--max-colors', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: beadify-text.ts --input image --analysis analysis.json --width 62 --output directory [--max-colors 221]');
  options.set(args[i], args[i + 1]);
}
for (const key of ['--input', '--analysis', '--width', '--output']) if (!options.has(key)) throw new Error(`Missing ${key}`);
const image = decodeTextImage(path.resolve(options.get('--input')!)), width = Number(options.get('--width'));
const input = path.resolve(options.get('--analysis')!); if ((await stat(input)).size > 2 * 1024 * 1024) throw new Error('Analysis exceeds 2 MiB');
const analysis: TextAnalysis = JSON.parse(await readFile(input, 'utf8')); validateTextAnalysis(analysis);
const extracted = extractTextEvidence(analysis, image);
const request: GenerationRequest = { schemaVersion: 1, revision: 0, image, palette: workspacePalette(basicPalette), width, height: Math.ceil(image.height / image.width * width),
  maxColors: Number(options.get('--max-colors') ?? 221), method: 'optimized', style: 'clean' };
const ordinary = generatePattern(request), result = generateTextCandidate(request, extracted.analysis, ordinary), output = path.resolve(options.get('--output')!);
await mkdir(output, { recursive: true });
for (const [name, pattern] of [['ordinary', ordinary], ['text', result.pattern]] as const) {
  await writeFile(path.join(output, `${name}.pattern.json`), JSON.stringify(pattern, null, 2) + '\n');
  await writeFile(path.join(output, `${name}.png`), textPatternPng(pattern));
}
await writeFile(path.join(output, 'text.bom.json'), JSON.stringify(buildBom(result.pattern), null, 2) + '\n');
await writeFile(path.join(output, 'source-analysis.json'), JSON.stringify(extracted.analysis, null, 2) + '\n');
const { pattern: _pattern, ...diagnostics } = result;
await writeFile(path.join(output, 'diagnostics.json'), JSON.stringify({ ...diagnostics, extraction: { version: extracted.version, regions: extracted.diagnostics } }, null, 2) + '\n');
console.log(JSON.stringify({ output, status: result.status, changedCells: result.changedCells.length, usedColors: result.pattern.diagnostics.usedColors }));

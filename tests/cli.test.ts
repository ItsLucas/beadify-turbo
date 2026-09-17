import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, open, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildBom, generatePattern } from '../src/beadify/core/index';
import type { GenerationRequest } from '../src/beadify/contracts/index';
import { bomToCsv, MAX_INPUT_BYTES } from '../scripts/beadify-cli';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (args: string[], cwd = root) => spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href, path.join(root, 'scripts/beadify-cli.ts'), ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
const request = (): GenerationRequest => ({
  schemaVersion: 1, revision: 7,
  image: { width: 3, height: 1, data: [255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 255, 0] },
  width: 3, height: 1, method: 'area', maxColors: 2,
  palette: {
    id: 'cli-test', version: '1', source: 'Original test swatches', license: 'CC0-1.0', approximate: true,
    colors: [
      { id: 'Test:Basic:W', brand: 'Test', series: 'Basic', code: 'W', srgb8: [255, 255, 255] },
      { id: 'Test:Basic:K', brand: 'Test', series: 'Basic', code: 'K', srgb8: [0, 0, 0] },
    ],
  },
});

test('CLI shares core output and exports exact BOM with white separate from empty', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beadify-cli-'));
  try {
    const input = path.join(directory, '输入 request.json'), output = path.join(directory, 'output with spaces');
    const data = request();
    await writeFile(input, JSON.stringify(data));
    const result = cli(['--input', input, '--output', output], directory);
    assert.equal(result.status, 0, result.stderr);
    const pattern = JSON.parse(await readFile(path.join(output, 'pattern.json'), 'utf8'));
    const bom = JSON.parse(await readFile(path.join(output, 'bom.json'), 'utf8'));
    assert.deepEqual(pattern, generatePattern(data));
    assert.deepEqual(pattern.cells, ['Test:Basic:W', 'Test:Basic:K', null]);
    assert.deepEqual(bom, buildBom(pattern));
    assert.equal(bom.totalBeads, 2);
    assert.equal(bom.rows.reduce((sum: number, row: { count: number }) => sum + row.count, 0), pattern.cells.filter((cell: unknown) => cell !== null).length);
    assert.equal(await readFile(path.join(output, 'bom.csv'), 'utf8'), bomToCsv(bom));
    assert.equal(JSON.parse(result.stdout).configHash, pattern.configHash);
    // Repeating generation produces byte-identical exported artifacts.
    const original = await readFile(path.join(output, 'pattern.json'), 'utf8');
    assert.equal(cli(['--input', input, '--output', output]).status, 0);
    assert.equal(await readFile(path.join(output, 'pattern.json'), 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI method override invokes the same nearest baseline', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beadify-cli-'));
  try {
    const data = request();
    const input = path.join(directory, 'request.json'), output = path.join(directory, 'result');
    await writeFile(input, JSON.stringify(data));
    const result = cli(['--input', input, '--output', output, '--method', 'nearest']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'pattern.json'), 'utf8')), generatePattern({ ...data, method: 'nearest' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI rejects malformed, invalid-schema, and oversized files before output creation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beadify-cli-'));
  try {
    const input = path.join(directory, 'request.json'), output = path.join(directory, 'result');
    for (const invalid of ['{', 'null', JSON.stringify({ ...request(), image: { width: 3, height: 1, data: [0] } }), JSON.stringify({ ...request(), maxColors: 0 }), JSON.stringify({ ...request(), unrecognized: true })]) {
      await writeFile(input, invalid);
      const result = cli(['--input', input, '--output', output]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /beadify:/);
      await assert.rejects(access(output));
    }
    const handle = await open(input, 'w');
    await handle.truncate(MAX_INPUT_BYTES + 1);
    await handle.close();
    const result = cli(['--input', input, '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /64 MiB/);
    await assert.rejects(access(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI rejects invalid arguments, reports help, and fails on output I/O errors', async () => {
  assert.equal(cli(['--help']).status, 0);
  for (const args of [[], ['--other', 'x'], ['--input'], ['--input', 'x', '--output', 'y', '--method', 'unknown'], ['--input', 'x', '--input', 'y', '--output', 'z']]) assert.notEqual(cli(args).status, 0);
  const directory = await mkdtemp(path.join(tmpdir(), 'beadify-cli-'));
  try {
    const input = path.join(directory, 'request.json');
    await writeFile(input, JSON.stringify(request()));
    assert.notEqual(cli(['--input', input, '--output', input]).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('BOM CSV quotes commas, embedded quotes, and line breaks', () => {
  const bom = buildBom(generatePattern(request()));
  bom.rows[0].brand = 'Brand, "special"\nseries';
  assert.ok(bomToCsv(bom).includes('"Brand, ""special""\nseries"'));
  assert.ok(bomToCsv(bom).endsWith('\r\n'));
});

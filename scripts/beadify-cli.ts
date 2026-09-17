#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBom, generatePattern } from '../src/beadify/core/index';
import type { Bom, GenerationRequest } from '../src/beadify/contracts/index';

export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

const usage = `Beadify standard RGBA CLI

Usage:
  npm exec tsx scripts/beadify-cli.ts -- --input REQUEST.json --output DIRECTORY [--method nearest|area|dominant|optimized]

REQUEST.json is a schemaVersion: 1 GenerationRequest with row-major RGBA bytes
in image.data. The request contains source dimensions, target grid dimensions,
palette metadata, revision, method, and maxColors. No image decoding is done.
The input must be a local regular file of at most 64 MiB. Core limits also apply:
source sides <= 4096, source pixels <= 4,194,304, grid sides <= 256.

Writes pattern.json, bom.json and bom.csv in DIRECTORY, replacing those three
files if they exist. Other files are left alone. Invalid input exits nonzero.
--method overrides the request's method. --help prints this message.
`;

interface CliOptions {
  input: string;
  output: string;
  method?: 'nearest' | 'area' | 'dominant' | 'optimized';
}

function parseOptions(args: string[]): CliOptions | null {
  // npm versions differ in whether they pass through this separator.
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return null;
  const options: Partial<CliOptions> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!['--input', '--output', '--method'].includes(name)) throw new Error(`Unknown option: ${name}`);
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    const key = name.slice(2) as keyof CliOptions;
    if (options[key] !== undefined) throw new Error(`Duplicate option: ${name}`);
    if (key === 'method') {
      if (!['nearest', 'area', 'dominant', 'optimized'].includes(value)) throw new Error('--method must be nearest, area, dominant or optimized');
      options.method = value as CliOptions['method'];
    } else {
      options[key] = value;
    }
  }
  if (!options.input || !options.output) throw new Error('Both --input and --output are required. Use --help for usage.');
  return options as CliOptions;
}

export async function readRequest(filename: string): Promise<GenerationRequest> {
  const info = await stat(filename);
  if (!info.isFile()) throw new Error('Input must be a regular JSON file');
  if (info.size > MAX_INPUT_BYTES) throw new Error('Input exceeds the 64 MiB file limit');
  const chunks: Buffer[] = [];
  let size = 0;
  // Bound the read as well as stat: a growing input cannot bypass the limit.
  for await (const chunk of createReadStream(filename)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_INPUT_BYTES) throw new Error('Input exceeds the 64 MiB file limit');
    chunks.push(bytes);
  }
  let request: unknown;
  try {
    request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('Input is not valid UTF-8 JSON');
  }
  // generatePattern performs the shared schema and semantic validation.
  return request as GenerationRequest;
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function bomToCsv(bom: Bom): string {
  const rows: Array<Array<string | number>> = [
    ['colorId', 'brand', 'series', 'code', 'red', 'green', 'blue', 'count'],
    ...bom.rows.map((row) => [row.colorId, row.brand, row.series, row.code, ...row.srgb8, row.count]),
  ];
  return `${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}

export async function runCli(args: string[]): Promise<void> {
  const options = parseOptions(args);
  if (!options) {
    process.stdout.write(usage);
    return;
  }
  const request = await readRequest(options.input);
  // Do not spread malformed requests: the core must see and reject their shape.
  if (options.method) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be an object');
    request.method = options.method;
  }
  const pattern = generatePattern(request);
  const bom = buildBom(pattern);
  const output = path.resolve(options.output);
  // Validate and generate everything before creating any output artifacts.
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'pattern.json'), `${JSON.stringify(pattern, null, 2)}\n`);
  await writeFile(path.join(output, 'bom.json'), `${JSON.stringify(bom, null, 2)}\n`);
  await writeFile(path.join(output, 'bom.csv'), bomToCsv(bom));
  process.stdout.write(`${JSON.stringify({ output, width: pattern.width, height: pattern.height, totalBeads: bom.totalBeads, usedColors: bom.rows.length, configHash: pattern.configHash })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`beadify: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('@playwright/test');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'generated/lite-validation'); fs.mkdirSync(output, { recursive: true });
  const folder = path.join(root, 'generated/web-lite'), manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json')));
  assert.equal(manifest.ai, false); assert.equal(manifest.profile, 'lite');
  for (const file of manifest.files) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(folder, file.path))).digest('hex'), file.sha256);
  assert.ok(!manifest.files.some(f => /\.(py|onnx|gguf|map)$|local-analysis-server|model-log|text-web-job/.test(f.path)));
  const port = Number(process.env.BEADIFY_LITE_TEST_PORT || 5201), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(folder, 'serve.cjs'), String(port)], { env: { ...process.env, BEADIFY_HOST: '127.0.0.1' }, stdio: 'pipe' });
  let browser, log = ''; server.stderr.on('data', b => log += b);
  const checks = [];
  try {
    for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error(log); try { if ((await fetch(origin)).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    const capabilities = await (await fetch(`${origin}/api/capabilities`)).json();
    assert.deepEqual(capabilities, { profile: 'lite', ai: false, ocr: false, vlm: false, scene: false });
    for (const endpoint of ['/api/text/ocr', '/api/text/vlm', '/api/scene/analyze']) {
      const r = await fetch(origin + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 404); assert.equal((await r.json()).code, 'AI_DISABLED');
    }
    assert.equal((await fetch(`${origin}/styles.css`, { method: 'POST', body: 'no upload' })).status, 405);
    assert.equal((await fetch(`${origin}/%2e%2e%2fpackage.json`)).status, 404);
    checks.push('Upload endpoints unavailable; traversal rejected');
    const asset = await fetch(`${origin}/src/beadify/runtime-profile.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(asset.headers.get('content-encoding'), 'gzip'); assert.match(await asset.text(), /AI_ENABLED = false/);
    const cached = await fetch(`${origin}/src/beadify/runtime-profile.js`, { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': asset.headers.get('etag') } });
    assert.equal(cached.status, 304);
    const head = await fetch(`${origin}/styles.css`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    checks.push('Precompressed assets, ETag and HEAD');
    browser = await chromium.launch({ headless: true, ...(process.env.BEADIFY_CHROMIUM ? { executablePath: process.env.BEADIFY_CHROMIUM } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), api = [], external = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url()); if (!r.url().startsWith(origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
    await page.goto(origin); await page.getByTestId('lite-profile').waitFor();
    assert.equal(await page.title(), 'Beadify Turbo');
    assert.equal(await page.getByTestId('scene-analysis-editor').count(), 0);
    assert.equal(await page.getByTestId('model-progress').count(), 0);
    assert.ok(!manifest.files.some(f => /SceneAnalysisEditor|scene-web/.test(f.path)));
    assert.equal(await page.getByRole('button', { name: /本地识别文字|Qwen3/ }).count(), 0);
    const refused = await page.evaluate(async () => {
      const { requestTextAnalysis } = await import('/src/beadify/text-web.js');
      return requestTextAnalysis('ocr', { width: 1, height: 1, data: [0, 0, 0, 255] }, undefined, new AbortController().signal).then(() => 'unexpected', e => e.message);
    });
    assert.match(refused, /关闭 OCR 和 VLM/); checks.push('Static workbench controls and client request guards');
    await page.getByLabel('Generation algorithm').selectOption('optimized');
    await page.getByLabel('Output width', { exact: true }).fill('12'); await page.getByLabel('Output height', { exact: true }).fill('12');
    await page.getByLabel('Color limit value', { exact: true }).fill('8');
    await page.getByTestId('generation-file').setInputFiles(path.join(root, 'benchmark/fixtures/04-white-eye-face.png'));
    await page.getByTestId('generation-candidate').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')));
    assert.ok(before.cells.some(Boolean)); assert.ok(new Set(before.cells.filter(Boolean)).size <= 8);
    const canvas = page.getByLabel('原图文字区域标注', { exact: true }); await canvas.scrollIntoViewIfNeeded(); const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height * .25); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .65); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')).beadify?.textAnalysis?.regions.length > 0);
    const manual = await page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')));
    assert.equal(manual.beadify.textAnalysis.provider.kind, 'manual'); assert.deepEqual(manual.cells, before.cells);
    assert.doesNotMatch(await page.locator('body').innerText(), /Qwen3|OCR|VLM|本地识别文字|模型分析|采用分类|忽略建议/);
    checks.push('CPU optimized generation, hard color budget and manual text annotation');
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '导出编辑', exact: true }).click();
    const saved = JSON.parse(fs.readFileSync(await (await downloadPromise).path(), 'utf8'));
    assert.deepEqual(saved.cells, manual.cells); assert.deepEqual(saved.beadify.textAnalysis, manual.beadify.textAnalysis);
    const pdfPromise = page.waitForEvent('download'); await page.evaluate(async () => {
      const { downloadPrintPdf } = await import('/src/exporters.js');
      await downloadPrintPdf(JSON.parse(localStorage.getItem('perler-beads-generator:draft')));
    });
    assert.match(fs.readFileSync(await (await pdfPromise).path(), 'latin1'), /^%PDF-1\.4/);
    await page.reload(); await page.getByTestId('lite-profile').waitFor();
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')))).cells, saved.cells);
    checks.push('Project roundtrip, no-source reload and browser PDF export');
    const core = await import(pathToFileURL(path.join(root, 'src/beadify/core/index.ts')));
    const request = { ...JSON.parse(fs.readFileSync(path.join(root, 'benchmark/fixtures/04-white-eye-face.request.json'))), method: 'optimized', width: 12, height: 12 };
    const actual = await page.evaluate(async input => {
      const { GenerationWorkerClient } = await import('/src/beadify/worker-client.js'); return new GenerationWorkerClient().generate(input);
    }, request);
    const { assertPatternEquivalent } = await import(pathToFileURL(path.join(root, 'tests/support/pattern-assertions.ts')));
    assertPatternEquivalent(actual, core.generatePattern(request)); checks.push('Lite real Worker equals full Node core');
    assert.deepEqual(api, []); assert.deepEqual(external, []); assert.deepEqual(errors, []);
    checks.push('Zero API requests, zero external requests, zero page errors');
    await page.screenshot({ path: path.join(output, 'workbench.png') });
    const report = { testedAt: new Date().toISOString(), profile: 'lite', checks, manifestFiles: manifest.files.length, apiRequests: api, externalRequests: external, pageErrors: errors };
    fs.writeFileSync(path.join(output, 'tests.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { await browser?.close(); server.kill('SIGTERM'); }
})().catch(error => { console.error(error); process.exitCode = 1; });

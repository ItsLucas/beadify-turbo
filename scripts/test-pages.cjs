// Verify the shipped workbench at a project subpath, or at a supplied Pages URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

(async () => {
  const root = path.resolve(__dirname, '..');
  const folder = path.join(root, 'generated/web-lite');
  const prefix = '/beadify-turbo/';
  let server, browser;
  try {
    let address = process.argv[2];
    if (!address) {
      server = http.createServer((req, res) => {
        const name = new URL(req.url, 'http://localhost').pathname;
        const relative = decodeURIComponent(name.slice(prefix.length)) || 'index.html';
        if (!name.startsWith(prefix) || relative.includes('..') || relative.includes('\\')) {
          res.writeHead(404); res.end(); return;
        }
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
        fs.readFile(path.join(folder, relative), (error, bytes) => {
          if (error) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': mime[path.extname(relative)] || 'application/octet-stream' });
          res.end(bytes);
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      address = `http://127.0.0.1:${server.address().port}${prefix}`;
    }
    const base = new URL(address);
    assert.ok(['http:', 'https:'].includes(base.protocol));
    assert.ok(base.pathname.endsWith('/'), 'Use the site URL with a trailing slash');
    browser = await chromium.launch({ headless: true, ...(process.env.BEADIFY_CHROMIUM ? { executablePath: process.env.BEADIFY_CHROMIUM } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], failed = [], outside = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', r => failed.push(`${r.failure()?.errorText} ${r.url()}`));
    page.on('request', r => {
      const url = new URL(r.url());
      if (['http:', 'https:'].includes(url.protocol) && (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))) outside.push(r.url());
    });
    const response = await page.goto(base.href);
    assert.equal(response.status(), 200);
    await page.getByTestId('lite-profile').waitFor();
    assert.equal(await page.title(), 'Beadify Turbo');
    await page.getByLabel('Generation algorithm').selectOption('optimized');
    await page.getByLabel('Output width', { exact: true }).fill('12');
    await page.getByLabel('Output height', { exact: true }).fill('12');
    await page.getByLabel('Color limit value', { exact: true }).fill('8');
    await page.getByTestId('generation-file').setInputFiles(path.join(root, 'benchmark/fixtures/04-white-eye-face.png'));
    await page.getByTestId('generation-candidate').waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: '接受为新图层', exact: true }).click();
    const project = await page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')));
    assert.ok(project.cells.some(Boolean));
    assert.ok(new Set(project.cells.filter(Boolean)).size <= 8);
    const savedFile = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出编辑', exact: true }).click();
    const saved = JSON.parse(fs.readFileSync(await (await savedFile).path(), 'utf8'));
    assert.deepEqual(saved.cells, project.cells);
    const pdf = page.waitForEvent('download');
    await page.evaluate(async () => {
      const { downloadPrintPdf } = await import(new URL('src/exporters.js', document.baseURI).href);
      await downloadPrintPdf(JSON.parse(localStorage.getItem('perler-beads-generator:draft')));
    });
    assert.match(fs.readFileSync(await (await pdf).path(), 'latin1'), /^%PDF-1\.4/);
    await page.reload();
    await page.getByTestId('lite-profile').waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('perler-beads-generator:draft')).cells), project.cells);
    assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(outside, []);
    console.log(`PASS ${base.href}: assets, Worker generation, project export/reload and PDF; no failed or out-of-path requests.`);
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Self-contained static server. No model modules, subprocesses or file uploads.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.profile !== 'lite' || manifest.ai !== false) throw new Error('Expected a Beadify Turbo package');
const files = new Map(manifest.files.map(file => [file.path, file]));
const port = Number(process.argv[2] || process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
function json(res, status, value, head = false) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(head ? undefined : bytes);
}
const server = http.createServer((req, res) => {
  let name;
  try { name = decodeURIComponent(req.url.split('?')[0]); }
  catch { json(res, 400, { error: 'Invalid URL' }); return; }
  if (name.startsWith('/api/')) {
    if (name === '/api/capabilities' && ['GET', 'HEAD'].includes(req.method)) json(res, 200, { profile: 'lite', ai: false, ocr: false, vlm: false, scene: false }, req.method === 'HEAD');
    else { res.setHeader('Connection', 'close'); json(res, 404, { code: 'AI_DISABLED', error: 'OCR and VLM are not included in this server' }); }
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); res.setHeader('Connection', 'close'); json(res, 405, { error: 'Static files only' }); return; }
  name = name === '/' ? 'index.html' : name.slice(1);
  if (!files.has(name) || name.includes('..') || name.includes('\\') || name.includes('\0')) { json(res, 404, { error: 'Not found' }); return; }
  const acceptsGzip = (req.headers['accept-encoding'] ?? '').split(',').some(value => /^\s*gzip(?:\s*;\s*q=(?:1(?:\.0*)?|0\.\d*[1-9]\d*))?\s*$/i.test(value));
  const compressed = acceptsGzip && files.has(`${name}.gz`);
  const file = files.get(compressed ? `${name}.gz` : name), etag = `"${file.sha256}"`;
  const headers = { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream', 'Content-Length': file.bytes,
    'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag, Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff',
    ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  const stream = fs.createReadStream(path.join(root, compressed ? `${name}.gz` : name));
  stream.once('open', () => { res.writeHead(200, headers); stream.pipe(res); });
  stream.once('error', () => { if (!res.headersSent) json(res, 404, { error: 'Not found' }); else res.destroy(); });
  res.once('close', () => stream.destroy());
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.on('error', error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
server.listen(port, process.env.BEADIFY_HOST || '0.0.0.0', () => console.log(`Beadify Turbo: http://${process.env.BEADIFY_HOST || '0.0.0.0'}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });

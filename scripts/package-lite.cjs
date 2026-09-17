const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), input = path.join(root, 'generated/dist'), output = path.join(root, 'generated/web-lite');
if (!fs.existsSync(path.join(input, 'src/beadify/runtime-profile.js'))) throw new Error('Run npm run build first');
if (process.argv.includes('--dry-run')) { console.log(`Package ${input} as ${output} with AI disabled`); process.exit(0); }
if (process.argv.length > 2) throw new Error('Usage: node scripts/package-lite.cjs [--dry-run]');
// Replace only this fixed, project-owned build output.
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(input, output, { recursive: true, filter: source => !source.endsWith('.map') });
fs.writeFileSync(path.join(output, 'src/beadify/runtime-profile.js'), 'export const AI_ENABLED = false;\n');
const html = path.join(output, 'index.html');
fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<title>Beadify Turbo</title>', '<title>Beadify Turbo</title>'));
fs.copyFileSync(path.join(root, 'scripts/serve-lite.cjs'), path.join(output, 'serve.cjs'));
fs.copyFileSync(path.join(root, 'deploy/beadify-turbo.service'), path.join(output, 'beadify-turbo.service'));
fs.copyFileSync(path.join(root, 'deploy/beadify-turbo.nginx.conf'), path.join(output, 'nginx.conf'));
fs.writeFileSync(path.join(output, 'START.txt'), `Beadify Turbo — bead pattern workbench\n\nRun with Node.js 22+: node serve.cjs\nOpen http://<server>:8080 ; custom port: node serve.cjs 8081\nNo npm install, Python or writable data directory is required.\nAlternatively host this directory using an existing static HTTP server (nginx.conf is included); then Node.js is unnecessary.\nDo not open index.html using file://; browser Workers require HTTP(S).\n\nImage generation, optimization, editing, text annotation/retyping and exports run in the visitor's browser.\nImages and projects are not uploaded to the server. Save project JSON to keep or move your work.\nThe server only serves static files.\n\nLinux systemd example:\n  Install the directory contents at /opt/beadify-turbo (readable by the service).\n  sudo install -m 644 beadify-turbo.service /etc/systemd/system/\n  sudo systemctl daemon-reload\n  sudo systemctl enable --now beadify-turbo.service\nThe sample uses /usr/bin/node, port 8080 and a 256 MiB service memory cap. Adjust paths/port for your machine.\nSee USAGE_RIGHTS.md: use only images you have the right to use. Software licensing does not grant rights to source artwork or commercial use of patterns.\n\nUpgrades: back up browser project JSON, retain the previous release directory, replace this directory, restart the static service and refresh the browser.\nRollback: restore the previous directory and restart. Do not downgrade project files without checking schema compatibility.\n\nPDF: print at 100% and verify the 50 mm ruler. Palette RGB values remain approximate.\n`);
const paths = [];
function scan(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const file = path.join(directory, entry.name); if (entry.isDirectory()) scan(file); else paths.push(file);
} }
scan(output);
for (const file of paths) {
  if (file.endsWith('.js')) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, ''));
  if (/\.(js|css|html|json|svg)$/.test(file)) fs.writeFileSync(`${file}.gz`, gzipSync(fs.readFileSync(file), { level: 9 }));
}
paths.length = 0; scan(output);
const files = paths.map(file => { const bytes = fs.readFileSync(file); return { path: path.relative(output, file).split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; });
const version = require('../package.json').version;
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ version, profile: 'lite', ai: false, files }, null, 2));
const archive = path.join(root, `generated/beadify-turbo-lite-${version}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', path.dirname(output), path.basename(output)]);
const archiveHash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${archiveHash}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ output, archive, archiveBytes: fs.statSync(archive).size, sha256: archiveHash, files: files.length, expandedBytes: files.reduce((n, f) => n + f.bytes, 0) }, null, 2));

// Tiny static server for local testing (no dependencies).
// Google sign-in and GPS need a real origin, not file://.
//   node serve.js            -> http://localhost:5173
//   PORT=8080 node serve.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = +process.env.PORT || 5173;
// 'localhost' can resolve to 127.0.0.1 or ::1 depending on the browser, so listen on both.
const HOSTS = process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1'];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
};

function handler(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/favicon.ico') { res.writeHead(204).end(); return; } // icon is inline in index.html
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

for (const host of HOSTS) {
  http.createServer(handler)
    .on('error', (e) => { if (host !== '::1') { console.error(`Can't listen on ${host}:${PORT}: ${e.message}`); process.exit(1); } }) // no IPv6 is fine
    .listen(PORT, host);
}
console.log(`PedalPace running at http://localhost:${PORT}  (Ctrl+C to stop)`);

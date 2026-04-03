/**
 * server.js  —  Rogo Web Dev Server + API Proxy
 *
 * Giải quyết CORS bằng cách proxy tất cả API call lên Rogo server
 * thay vì để browser gọi trực tiếp.
 *
 * Dùng: node server.js
 * Mở:  http://localhost:3000/dashboard.html
 *
 * Proxy routes:
 *   /proxy/openapi/* → https://openapi.rogo.com.vn/*
 *   /proxy/device/*  → https://device.rogo.com.vn/*   (production)
 *   /proxy/staging/* → https://device.rogo.com.vn/staging/*
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = 3000;

// MIME types cho static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
};

// Proxy targets
const PROXY_MAP = {
  '/proxy/openapi': 'https://openapi.rogo.com.vn',
  '/proxy/device':  'https://device.rogo.com.vn',
  '/proxy/staging': 'https://device.rogo.com.vn/staging',
};

/* ---- Proxy one request ---- */
function proxyRequest(req, res, targetBase, stripPrefix) {
  const parsedTarget = new url.URL(targetBase);
  const upstreamPath = req.url.replace(stripPrefix, '') || '/';

  const options = {
    hostname: parsedTarget.hostname,
    port:     parsedTarget.port || 443,
    path:     (parsedTarget.pathname === '/' ? '' : parsedTarget.pathname) + upstreamPath,
    method:   req.method,
    headers:  { ...req.headers, host: parsedTarget.hostname },
  };
  // Remove headers that cause issues
  delete options.headers['origin'];
  delete options.headers['referer'];

  const proto = parsedTarget.protocol === 'https:' ? https : http;

  const upstream = proto.request(options, upRes => {
    res.writeHead(upRes.statusCode, {
      ...upRes.headers,
      'access-control-allow-origin':  '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    upRes.pipe(res);
  });

  upstream.on('error', err => {
    console.error('[proxy] upstream error:', err.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'Proxy upstream error', detail: err.message }));
  });

  req.pipe(upstream);
}

/* ---- Serve static file ---- */
function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? '/index.html' : req.url.split('?')[0]);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---- Main server ---- */
const server = http.createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':  '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    });
    res.end();
    return;
  }

  // Route proxy requests
  for (const [prefix, target] of Object.entries(PROXY_MAP)) {
    if (req.url.startsWith(prefix)) {
      console.log(`[proxy] ${req.method} ${req.url} → ${target}`);
      proxyRequest(req, res, target, prefix);
      return;
    }
  }

  // Serve static files
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n✅  Rogo Dev Server đang chạy tại http://localhost:${PORT}`);
  console.log(`    Mở dashboard: http://localhost:${PORT}/dashboard.html\n`);
  console.log('    Proxy routes:');
  for (const [prefix, target] of Object.entries(PROXY_MAP)) {
    console.log(`      http://localhost:${PORT}${prefix}/* → ${target}/*`);
  }
  console.log('\n    Nhấn Ctrl+C để dừng server.\n');
});

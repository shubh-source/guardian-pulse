const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Create the standalone Child PWA HTTP server.
 * Serves the Child Tracker UI and forwards /api/* telemetry calls to the Parent API server.
 */
function createChildApp(options = {}) {
  const apiBaseUrl = (options.apiBaseUrl || process.env.PARENT_API_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, 'public'));

  function serveStatic(res, relativePath) {
    const safeRel = relativePath.replace(/^\/+/, '');
    const targetPath = path.resolve(publicDir, safeRel);
    if (!targetPath.startsWith(publicDir + path.sep) && targetPath !== publicDir) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    fs.stat(targetPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(targetPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const cacheControl =
        ext === '.html' || safeRel === 'sw.js' ? 'no-cache' : 'public, max-age=300';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': cacheControl,
      });
      fs.createReadStream(targetPath).pipe(res);
    });
  }

  function proxyApi(req, res) {
    const target = new URL(req.url, apiBaseUrl);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: target.host };

    const proxyReq = transport.request(
      target,
      {
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        const body = JSON.stringify({
          error: `Parent API server unreachable at ${apiBaseUrl}: ${err.message}`,
        });
        res.writeHead(502, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      }
    });

    req.pipe(proxyReq);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      return proxyApi(req, res);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET') {
      return serveStatic(res, url.pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  });

  return {
    server,
    close() {
      if (server.listening) {
        server.close();
      }
    },
  };
}

if (require.main === module) {
  const PORT = Number(process.env.CHILD_PORT || process.env.PORT || 3002);
  const HOST = process.env.HOST || '0.0.0.0';
  const PARENT_API_URL = process.env.PARENT_API_URL || 'http://127.0.0.1:3001';

  const { server, close } = createChildApp({ apiBaseUrl: PARENT_API_URL });
  server.listen(PORT, HOST, () => {
    console.log(`GuardianPulse CHILD App running at http://localhost:${PORT}`);
    console.log(`  Forwarding telemetry API to ${PARENT_API_URL}`);
  });

  function shutdown() {
    console.log('\nShutting down GuardianPulse Child App...');
    close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createChildApp };

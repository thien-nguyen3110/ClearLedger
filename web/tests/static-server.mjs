// Minimal static file server for the production bundle, used only by the browser test
// suite (playwright.config.js). Serves web/dist exactly as the Go backend's
// http.FileServer would for the same directory, with no /api/* handling: tests intercept
// those requests at the network layer instead.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT || 15173);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain' };

const server = createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  // Resolve against dist and require the result to stay inside it (handles "..", "\" on
  // Windows, and sibling directories whose names merely start with "dist").
  const filePath = resolve(root, '.' + (urlPath === '/' ? '/index.html' : urlPath));
  if (filePath !== root && !filePath.startsWith(root + sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => console.log('static server listening on http://127.0.0.1:' + port));

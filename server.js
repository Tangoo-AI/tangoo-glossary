const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 5180;
const TYPES = { '.html':'text/html', '.json':'application/json', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.png':'image/png' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Tangoo Glossary serving on port ' + PORT));

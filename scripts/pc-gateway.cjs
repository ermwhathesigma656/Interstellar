// Runs inside Windows, behind Caddy HTTPS. VNC itself only accepts localhost.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const { timingSafeEqual } = require('node:crypto');
const { WebSocketServer, createWebSocketStream } = require('ws');
const { key } = JSON.parse(fs.readFileSync('C:/Interstellar/gateway.json', 'utf8'));
const expected = Buffer.from(`Bearer ${key}`);
function authorized(request) {
  const actual = Buffer.from(request.headers.authorization || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const server = http.createServer((request, response) => {
  response.writeHead(authorized(request) && request.url === '/health' ? 200 : 403, { 'Cache-Control': 'no-store' });
  response.end(authorized(request) && request.url === '/health' ? 'ready' : 'Forbidden');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
server.on('upgrade', (request, socket, head) => {
  if (!authorized(request) || request.url !== '/desktop' || wss.clients.size) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => {
    const tcp = net.connect(5900, '127.0.0.1');
    const stream = createWebSocketStream(ws);
    stream.pipe(tcp).pipe(stream);
    const close = () => { tcp.destroy(); stream.destroy(); ws.terminate(); };
    tcp.on('error', close);
    tcp.on('close', close);
    stream.on('error', close);
    ws.on('close', close);
  });
});
server.listen(6080, '127.0.0.1');

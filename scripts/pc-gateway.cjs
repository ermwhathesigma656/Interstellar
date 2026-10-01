// Runs inside Windows, behind Caddy HTTPS. VNC itself only accepts localhost.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual, randomUUID } = require('node:crypto');
const { WebSocketServer, createWebSocketStream } = require('ws');
const MAX_UPLOAD = 50 * 1024 * 1024;
function createGateway({ key, downloads }) {
const bootId = randomUUID();
let uploading = false;
const expected = Buffer.from(`Bearer ${key}`);
function authorized(request) {
  const actual = Buffer.from(request.headers.authorization || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const server = http.createServer(async (request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (!authorized(request)) return reply(403, { error: 'Forbidden' });
  if (request.method === 'GET' && request.url === '/health') return reply(200, { bootId });
  if (request.method !== 'POST' || request.url !== '/upload') return reply(404, { error: 'Not found' });
  let name;
  try { name = decodeURIComponent(request.headers['x-filename'] || ''); } catch { return reply(400, { error: 'Invalid filename.' }); }
  if (!name || name.length > 180 || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name)) {
    return reply(400, { error: 'Rename this file using a normal Windows filename.' });
  }
  const size = Number(request.headers['x-file-size']);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD) return reply(413, { error: 'Files must be between 1 byte and 50 MB.' });
  if (uploading) return reply(409, { error: 'Wait for the current upload to finish.' });
  if (!downloads) return reply(503, { error: 'File uploads are not configured.' });
  uploading = true;
  let file, partial, result, resultStatus = 200;
  try {
    await fs.promises.mkdir(downloads, { recursive: true });
    partial = path.join(downloads, `.${randomUUID()}.part`);
    file = await fs.promises.open(partial, 'wx');
    let received = 0;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > size || received > MAX_UPLOAD) throw new Error('size');
      await file.writeFile(chunk);
    }
    if (received !== size) throw new Error('size');
    await file.close(); file = null;
    if (process.platform === 'win32') await fs.promises.writeFile(`${partial}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    // Publish atomically; never overwrite an existing file or follow a destination symlink.
    await fs.promises.link(partial, path.join(downloads, name));
    result = { name, bytes: received };
  } catch (error) {
    resultStatus = error.code === 'EEXIST' ? 409 : error.message === 'size' ? 400 : 503;
    result = { error: error.code === 'EEXIST' ? 'That filename already exists in Windows Downloads. Rename it before uploading again.' : 'Upload interrupted. Please try again.' };
  } finally {
    await file?.close().catch(() => {});
    if (partial) await fs.promises.unlink(partial).catch(() => {});
    uploading = false;
  }
  reply(resultStatus, result);
});
server.requestTimeout = 120000;
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
server.on('upgrade', (request, socket, head) => {
  if (!authorized(request) || request.url !== '/desktop') {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  // The Worker validates the exclusive lease. Reconnect replaces an abandoned socket.
  for (const old of wss.clients) old.terminate();
  wss.handleUpgrade(request, socket, head, ws => {
    const tcp = net.connect({ port: 5900, host: '127.0.0.1', noDelay: true });
    const stream = createWebSocketStream(ws);
    stream.pipe(tcp).pipe(stream);
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false; ws.ping();
    }, 20000);
    const close = () => { clearInterval(ping); tcp.destroy(); stream.destroy(); ws.terminate(); };
    tcp.on('error', close);
    tcp.on('close', close);
    stream.on('error', close);
    ws.on('error', close);
    ws.on('close', close);
  });
});
server.on('close', () => { for (const ws of wss.clients) ws.terminate(); wss.close(); });
return server;
}
module.exports = { createGateway };
if (require.main === module) createGateway(JSON.parse(fs.readFileSync('C:/Interstellar/gateway.json', 'utf8'))).listen(6080, '127.0.0.1');

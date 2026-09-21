// BareMux transport using Workers' HTTP/WebSocket APIs instead of raw TCP.
export default class WorkerTransport {
  ready = false;
  constructor(endpoint) { this.endpoint = endpoint; }
  async init() { this.ready = true; }
  meta() { return {}; }

  async request(remote, method, body, headers, signal) {
    // ponytail: buffer streamed uploads; use duplex streaming if large uploads are needed.
    if (body instanceof ReadableStream) body = await new Response(body).arrayBuffer();
    const response = await fetch(this.endpoint, {
      method: "POST", body, signal, cache: "no-store",
      headers: {
        "X-Proxy-Target": remote.href,
        "X-Proxy-Method": method,
        "X-Proxy-Headers": encodeURIComponent(JSON.stringify(headers)),
      },
    });
    if (!response.ok) throw new Error(await response.text());
    const metadata = JSON.parse(decodeURIComponent(response.headers.get("X-Proxy-Response")));
    return { ...metadata, body: response.body ?? new ArrayBuffer(0) };
  }

  connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
    const socket = new WebSocket(this.endpoint.replace(/^http/, "ws"));
    socket.binaryType = "arraybuffer";
    let opened = false;
    socket.onopen = () => socket.send(JSON.stringify({ url: url.href, protocols, headers }));
    socket.onmessage = event => {
      if (opened) onmessage(event.data);
      else {
        try {
          const { protocol } = JSON.parse(event.data);
          opened = true;
          onopen(protocol);
        } catch { onerror("Invalid proxy handshake"); socket.close(); }
      }
    };
    socket.onclose = event => onclose(event.code, event.reason);
    socket.onerror = () => onerror("WebSocket connection failed");
    return [(data) => socket.send(data), (code, reason) => socket.close(code, reason)];
  }
}

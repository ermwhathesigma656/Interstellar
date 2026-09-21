import { isIP } from "node:net";
import { discordAssetURL } from "./discord-assets.js";

function destination(value, origin, protocols) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!protocols.includes(url.protocol) || url.username || url.password || url.port ||
      isIP(hostname) || !hostname.includes(".") || /\.(localhost|local|internal)$/.test(hostname) ||
      hostname === new URL(origin).hostname) throw new Error("Destination is not a public website");
  return url;
}

function upstreamHeaders(values = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (/^(host|connection|content-length|transfer-encoding|upgrade|accept-encoding|sec-websocket-.+|cf-.+|x-forwarded-.+)$/i.test(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(name.toLowerCase() === "cookie" ? "; " : ", ") : value);
  }
  return headers;
}

function close(socket, code = 1011, reason = "Proxy connection failed") {
  if (socket.readyState === 1) socket.close(code === 1006 || code === 1005 ? 1000 : code, reason);
}

function websocket(request) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  let upstream;
  const timeout = setTimeout(() => close(server, 1008, "Missing connection details"), 15000);
  server.addEventListener("close", event => {
    clearTimeout(timeout);
    if (upstream) close(upstream, event.code, event.reason);
  });
  server.addEventListener("message", async event => {
    try {
      if (typeof event.data !== "string" || event.data.length > 65536) throw new Error("Invalid connection details");
      const details = JSON.parse(event.data);
      const url = destination(details.url, request.url, ["ws:", "wss:"]);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      const headers = upstreamHeaders(details.headers);
      headers.set("Upgrade", "websocket");
      if (details.protocols?.length) headers.set("Sec-WebSocket-Protocol", details.protocols.join(", "));
      const response = await fetch(url, { headers, redirect: "manual" });
      upstream = response.webSocket;
      if (!upstream) throw new Error(`WebSocket upgrade failed (${response.status})`);
      upstream.accept();
      clearTimeout(timeout);
      if (server.readyState !== 1) { close(upstream); return; }
      server.addEventListener("message", message => {
        if (upstream.readyState === 1) upstream.send(message.data);
      });
      upstream.addEventListener("message", message => {
        if (server.readyState === 1) server.send(message.data);
      });
      upstream.addEventListener("close", event => close(server, event.code, event.reason));
      upstream.addEventListener("error", () => close(server));
      server.addEventListener("error", () => close(upstream));
      server.send(JSON.stringify({ protocol: response.headers.get("Sec-WebSocket-Protocol") || "" }));
    } catch (error) {
      clearTimeout(timeout);
      close(server, 1011, error.message.slice(0, 100));
    }
  }, { once: true });
  return new Response(null, { status: 101, webSocket: client });
}

export async function proxyHTTP(request, env) {
  const origin = request.headers.get("Origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return new Response("Cross-origin proxy requests are not allowed", { status: 403 });
  }
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return websocket(request);
  if (request.method !== "POST") return new Response("Use POST", { status: 405 });
  let url, headers, method;
  try {
    url = destination(request.headers.get("X-Proxy-Target"), request.url, ["http:", "https:"]);
    headers = upstreamHeaders(JSON.parse(decodeURIComponent(request.headers.get("X-Proxy-Headers") || "%7B%7D")));
    method = request.headers.get("X-Proxy-Method") || "GET";
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new Error("Unsupported method");
  } catch (error) {
    return new Response(error.message, { status: 400 });
  }
  try {
    const asset = env.DISCORD_ASSETS && ["GET", "HEAD"].includes(method) && discordAssetURL(url);
    const response = asset ? await env.DISCORD_ASSETS.getByName("public-assets").fetch(new Request(asset, { method })) : await fetch(url, {
      method, headers, redirect: "manual", signal: request.signal,
      body: ["GET", "HEAD"].includes(method) ? null : request.body,
    });
    const rawHeaders = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) rawHeaders["set-cookie"] = cookies;
    delete rawHeaders["content-encoding"];
    delete rawHeaders["content-length"];
    const outgoing = new Headers({
      "Content-Type": "application/octet-stream", "Cache-Control": "no-store",
      "X-Proxy-Response": encodeURIComponent(JSON.stringify({ status: response.status, statusText: response.statusText, headers: rawHeaders })),
    });
    if (response.headers.has("content-encoding")) outgoing.set("Content-Encoding", response.headers.get("content-encoding"));
    return new Response(response.body, { headers: outgoing });
  } catch {
    return new Response("The destination could not be reached", { status: 502 });
  }
}

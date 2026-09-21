import { connect } from "cloudflare:sockets";
import { httpServerHandler } from "cloudflare:node";
import { createServer } from "node:http";
import express from "express";
import basicAuth from "express-basic-auth";
import config from "../config.js";
import manifest from "../dist/.runtime/vendor-map.cjs";
import { mountAnalytics } from "./analytics.js";
import { proxyHTTP } from "./worker-http.js";
import puppeteer from "@cloudflare/puppeteer";

// Use the package's Node entry so its network filters remain available.
const { server: wisp } = require("@mercuryworkshop/wisp-js/server");
wisp.options.allow_udp_streams = false;
wisp.options.stream_limit_total = 32;
// Workers resolves hostnames and rejects private destination IPs in connect().
wisp.options.dns_method = async hostname => hostname;

class WorkerTCPSocket {
  constructor(hostname, port) {
    this.hostname = hostname;
    this.port = port;
  }
  async connect() {
    if (this.closed) throw new Error("Stream closed before connecting");
    this.socket = connect({ hostname: this.hostname, port: this.port });
    this.socket.closed.catch(() => {});
    await this.socket.opened;
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }
  async recv() {
    const { value, done } = await this.reader.read();
    return done ? null : value;
  }
  send(data) { return this.writer.write(data); }
  close() { this.closed = true; this.socket?.close().catch(() => {}); }
  // Reading one chunk at a time supplies the TCP backpressure.
  pause() {}
  resume() {}
}

function upgradeWisp(request) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket connection", { status: 426 });
  }
  const offered = request.headers.get("Sec-WebSocket-Protocol")?.split(",").map(value => value.trim()) ?? [];
  const protocol = offered.find(value => value === "wisp-v2");
  const [client, server] = Object.values(new WebSocketPair());
  server.binaryType = "arraybuffer";
  server.accept();
  const socket = {
    OPEN: 1,
    get readyState() { return server.readyState; },
    // ponytail: Workers owns WebSocket buffering; TCP reads stay one chunk at a time.
    get bufferedAmount() { return server.bufferedAmount ?? 0; },
    set onmessage(handler) { server.addEventListener("message", handler); },
    set onclose(handler) { server.addEventListener("close", handler); },
    send(data) { server.send(data); },
    close(code = 1000, reason = "") {
      if (server.readyState === 1) server.close(code, reason);
    },
  };
  const connection = new wisp.ServerConnection(socket, "/wisp/", {
    TCPSocket: WorkerTCPSocket,
    wisp_version: protocol ? 2 : 1,
    wisp_extensions: [],
  });
  connection.setup().then(() => connection.run()).catch(async error => {
    console.error("Wisp connection failed:", error.message);
    await connection.cleanup();
  });
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {},
  });
}

let nodeHandler;
async function handleNode(request, env, ctx) {
  nodeHandler ??= (async () => {
    // The existing rate limiter starts a timer, which Workers permits only in a request.
    const { mountGhGames } = await import("./games.js");
    const app = express();
    mountGhGames(app);
    if (manifest.analytics) mountAnalytics(app, manifest.analytics);
    app.use((_req, res) => res.sendStatus(404));
    const server = createServer(app);
    server.listen(8080);
    return httpServerHandler({ port: 8080 });
  })();
  return (await nodeHandler).fetch(request, env, ctx);
}

const pages = new Map([["/", "/index.html"], ["/play.html", "/games.html"]]);
for (const [route, generated] of Object.entries(manifest.routes)) {
  pages.set(route, `${route}.html`);
  pages.set(generated, `${route}.html`);
}

export default {
  async fetch(request, env, ctx) {
    if (config.challenge !== false) {
      const supplied = request.headers.get("Authorization")?.replace(/^Basic\s+/i, "") ?? "";
      const authorized = Object.entries(config.users).some(([user, password]) =>
        basicAuth.safeCompare(supplied, Buffer.from(`${user}:${password}`).toString("base64")),
      );
      if (!authorized) return new Response("Authentication required", {
        status: 401, headers: { "WWW-Authenticate": 'Basic realm="Interstellar"' },
      });
    }
    const url = new URL(request.url);
    // Temporary deployment check; removed once the Cloudflare browser path is verified.
    if (url.pathname === "/browser-check") {
      const cacheKey = new Request(url.origin + "/browser-check");
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      let browser, result;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        const asset = await page.goto("https://discord.com/assets/533077.aaffa7a528706cc2.js", { waitUntil: "domcontentloaded", timeout: 15000 });
        const body = await asset.text();
        result = { status: asset.status(), type: asset.headers()["content-type"], bytes: body.length, start: body.slice(0, 100) };
      } catch (error) {
        result = { error: error.message };
      } finally {
        await browser?.close();
      }
      const response = Response.json(result, { headers: { "Cache-Control": "public, max-age=86400" } });
      await caches.default.put(cacheKey, response.clone());
      return response;
    }
    if (url.pathname === "/http/") return proxyHTTP(request);
    if (url.pathname === "/worker-transport.json") return Response.json({ transport: "/worker-transport.mjs?v=1" });
    if (url.pathname === "/wisp/") return upgradeWisp(request);
    if (url.pathname.startsWith("/.runtime")) return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/gh-games/") ||
        [manifest.analytics?.loader, manifest.analytics?.sink].includes(url.pathname)) {
      return handleNode(request, env, ctx);
    }
    url.pathname = pages.get(url.pathname) ?? url.pathname;
    const response = await env.ASSETS.fetch(new Request(url, request));
    const result = new Response(response.body, response);
    if (/\.m?js$/.test(url.pathname)) result.headers.set("Service-Worker-Allowed", "/");
    return result;
  },
};

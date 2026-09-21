// Run after `wrangler dev`: node src/check-worker.js [https://your-worker.workers.dev]
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { connect as connectTLS } from "node:tls";
import { client, packet } from "@mercuryworkshop/wisp-js/client";
import manifest from "../dist/.runtime/vendor-map.cjs";
import WorkerTransport from "../static/worker-transport.mjs";
import { createHash } from "node:crypto";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const deadline = setTimeout(() => { console.error("Worker check timed out"); process.exit(1); }, 90000);
const paths = ["/", "/apps", "/games", "/settings", "/tabs", "/play.html"];
if (!process.argv[2]) paths.push(...Object.values(manifest.routes));
for (const path of paths) {
  const response = await fetch(base + path, { redirect: "manual" });
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get("content-type"), /text\/html/);
  await response.body.cancel();
}
for (const path of ["/.runtime/vendor-map.cjs", "/.runtime/worker.mjs", "/not-a-real-page"]) {
  const response = await fetch(base + path);
  assert.equal(response.status, 404, path);
  await response.body.cancel();
}
if (!process.argv[2]) {
  const sw = await fetch(base + manifest.sw);
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get("service-worker-allowed"), "/");
  await sw.body.cancel();
}
await Promise.all(["/gh-games/4/games/1/index.html", "/gh-games/2/Cluster-Rush/index.html"].map(async path => {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  assert.match(await response.text(), /<html/i, path);
}));

const workerConfig = await (await fetch(base + "/worker-transport.json")).json();
assert.match(workerConfig.transport, /^\/worker-transport\.mjs\?/);
const native = new WorkerTransport(base + "/http/");
let discordAppError;
for (const address of ["https://discord.com/login", "https://discord.com/api/v9/gateway"]) {
  const response = await native.request(new URL(address), "GET", null, {}, undefined);
  assert.equal(response.status, 200, address);
  const body = await new Response(response.body).text();
  assert.match(body, /discord/i);
  if (address.endsWith("/login")) {
    const scripts = Array.from(body.matchAll(/<script[^>]*src="([^\"]+\.js)"/g), match => match[1]);
    assert.ok(scripts.length, "Discord login must contain app scripts");
    for (const path of [scripts[0], scripts.at(-1)]) {
      const url = new URL(path, address);
      const asset = await native.request(url, "GET", null, {}, undefined);
      const bytes = Buffer.from(await new Response(asset.body).arrayBuffer());
      if (asset.status !== 200) { discordAppError = `Discord app script: HTTP ${asset.status} ${bytes.toString().slice(0,120)}`; continue; }
      const expected = Buffer.from(await (await fetch(url)).arrayBuffer());
      const hash = data => createHash("sha256").update(data).digest("hex");
      assert.equal(hash(bytes), hash(expected), "Discord script must match the original bytes");
      const cached = await native.request(url, "GET", null, {}, undefined);
      assert.equal(cached.headers["x-asset-cache"], "hit", "Repeated public assets must use Cloudflare storage");
      assert.equal(hash(Buffer.from(await new Response(cached.body).arrayBuffer())), hash(bytes), "Cached script must remain intact");
      console.log(`Discord asset: ${bytes.length} bytes, original and cached copies verified`);
    }
  }
}
for (const address of ["https://127.0.0.1/", "https://[::1]/", "https://localhost/", base + "/", "file:///etc/passwd"]) {
  await assert.rejects(native.request(new URL(address), "GET", null, {}, undefined), /Destination is not a public website/);
}
const crossOrigin = await fetch(base + "/http/", { method: "POST", headers: { Origin: "https://unrelated.example" } });
assert.equal(crossOrigin.status, 403);
await crossOrigin.body.cancel();
await new Promise((resolve, reject) => {
  const [, close] = native.connect(new URL("wss://gateway.discord.gg/?v=9&encoding=json"), [], {}, () => {}, data => {
    try {
      assert.equal(JSON.parse(data).op, 10, "Discord gateway hello");
      close(1000, "Test complete");
      resolve();
    } catch (error) { reject(error); }
  }, (code, reason) => { if (code !== 1000) reject(new Error(`Gateway closed: ${code} ${reason}`)); }, reject);
});
console.log("Native HTTP: Discord login HTML, API, gateway, and destination/origin protection passed");

for (const version of [1, 2]) {
  const connection = new client.ClientConnection(base.replace(/^http/, "ws") + "/wisp/", { wisp_version: version });
  try {
    await new Promise((resolve, reject) => {
      connection.onopen = resolve;
      connection.onerror = () => reject(new Error("Wisp connection failed"));
    });
    assert.equal(connection.wisp_version, version, "Wisp version negotiation");
    const reason = await new Promise(resolve => {
      connection.create_stream("127.0.0.1", 80).onclose = resolve;
    });
    assert.equal(reason, packet.close_reasons.HostBlocked, "Private destinations must stay blocked");
    const stream = connection.create_stream("www.google.com", version === 2 ? 443 : 80);
    const transport = new Duplex({
      read() {},
      write(data, _encoding, callback) { stream.send(data); callback(); },
      destroy(error, callback) { stream.close(); callback(error); },
    });
    stream.onmessage = data => transport.push(Buffer.from(data));
    stream.onclose = () => transport.push(null);
    const socket = version === 2 ? connectTLS({ socket: transport, servername: "www.google.com" }) : transport;
    let body = "";
    socket.setEncoding("utf8");
    const received = new Promise((resolve, reject) => {
      socket.on("data", chunk => { body += chunk; });
      socket.on("end", resolve);
      socket.on("error", reject);
    });
    socket.write("GET /generate_204 HTTP/1.1\r\nHost: www.google.com\r\nConnection: close\r\n\r\n");
    await received;
    assert.match(body, /^HTTP\/1\.[01] 204/, `Wisp v${version} ${version === 2 ? "HTTPS" : "HTTP"}`);
    socket.destroy();
    console.log(`Wisp v${version}: ${version === 2 ? "HTTPS" : "HTTP"} request and private-address blocking passed`);
  } finally {
    connection.close();
  }
}
clearTimeout(deadline);
console.log("Worker infrastructure checks passed; checking full Discord app compatibility.");
assert.equal(discordAppError, undefined, "Full Discord app compatibility check");

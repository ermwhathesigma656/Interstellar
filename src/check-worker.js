// Run after `wrangler dev`: node src/check-worker.js [https://your-worker.workers.dev]
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { connect as connectTLS } from "node:tls";
import { client, packet } from "@mercuryworkshop/wisp-js/client";
import manifest from "../dist/.runtime/vendor-map.cjs";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const deadline = setTimeout(() => { console.error("Worker check timed out"); process.exit(1); }, 45000);
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
console.log("Worker pages, generated routes, service worker headers, and proxy checks passed.");

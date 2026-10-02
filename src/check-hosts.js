import assert from "node:assert/strict";
import { routeHost } from "./worker-hosts.js";
const old = "https://schoolwork.gonicvrnew.workers.dev", current = "https://schoolworkv2.gonicvrnew.workers.dev";
const original = "https://interstellar.gonicvrnew.workers.dev";
let forwarded;
const env = { PC_BACKEND: { fetch: request => { forwarded = request; return new Response("shared backend"); } } };
const moved = routeHost(new Request(old + "/pc?from=home"), env);
assert.equal(moved.status, 307);
assert.equal(moved.headers.get("Location"), current + "/pc?from=home");
assert.equal(routeHost(new Request(current + "/pc"), env), null);
for (const host of [old, current, "https://new-example.gonicvrnew.workers.dev"]) {
  await routeHost(new Request(host + "/api/pc/release", { method: "POST", headers: { Origin: host, Cookie: "ispc=test" }, body: '{"lease":"test"}' }), env);
  assert.equal(forwarded.url, original + "/api/pc/release");
  assert.equal(forwarded.headers.get("Origin"), original);
  assert.equal(forwarded.headers.get("Cookie"), "ispc=test");
  assert.equal(await forwarded.text(), '{"lease":"test"}');
}
await routeHost(new Request(current + "/api/ai/chat", { method: "POST", headers: { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" } }), env);
assert.equal(forwarded.headers.get("Origin"), "https://evil.test");
assert.equal(forwarded.headers.get("Sec-Fetch-Site"), "cross-site");
assert.equal(routeHost(new Request(original + "/api/pc/me"), env), null);
console.log("Host checks passed: redirect paths, shared accounts, bodies/cookies, no forwarding loop, cross-site protection.");
